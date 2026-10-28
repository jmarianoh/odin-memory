// Contraste diferencial de captura pasiva, estadísticas, listado de proyectos y consolidación.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Store, addObservation, consolidateObservations, createSession, getObservation, listProjectsWithStats, passiveCapture, stats,
} from '../../src/store/index.js';
import { resolveBinary, startMcp } from './engram-mcp.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const binary = resolveBinary();
const skip = binary ? false : 'defina ENGRAM_BIN o ENGRAM_SRC';
const SESSION = 'manual-save-odin-memory';

let engram;
let tmp;
let odin;
before(() => {
  if (!binary) return;
  engram = startMcp(binary.bin, { cwd: repoRoot });
  tmp = mkdtempSync(join(tmpdir(), 'conformance-odin-'));
  odin = Store.open({ dataDir: join(tmp, 'data'), log: () => {} });
  createSession(odin, SESSION, 'odin-memory', repoRoot, 'project_owned');
});
after(() => {
  engram?.close();
  odin?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  binary?.cleanup();
});

const save = async (o) => {
  const ref = await engram.call('mem_save', o);
  assert.equal(ref.isError, false, ref.text);
  const mine = addObservation(odin, { session_id: SESSION, ...o });
  assert.equal(mine.id, ref.json.id);
  return mine.id;
};

const PASSIVE = [
  '## Key Learnings:\n1. Los reintentos deben usar espera exponencial\n2. WAL permite lectores concurrentes con un escritor\n',
  '## Key Learnings:\n1. Los reintentos deben usar espera exponencial\n', // duplicado
  '### Aprendizajes Clave\n- **Siempre** validar la entrada `externa` antes de usarla\n* Preferir *composición* sobre herencia en los módulos\n- corto\n',
  '## Learnings\n1. Primera sección con contenido válido aquí\n\n## Learnings\n- tres palabras ok\n',
  '## Learning:\n- Una viñeta con suficientes palabras y bastante longitud para forzar el recorte del título a sesenta bytes\n',
  '## Aprendizajes\n- Los títulos con acentos como éééééééééééééééééééééééééééééé se recortan sin romper caracteres\n',
  '## Learnings\r\n- Texto con saltos de línea CRLF debe limpiarse igualmente bien\r\n- Otra línea CRLF con palabras suficientes para contar\r\n',
  '## Key Learnings\n\nTexto libre sin lista que no debe extraerse como aprendizaje alguno\n',
  'Sin encabezado de aprendizajes\n- una viñeta cualquiera con muchas palabras suficientes\n',
  '## Learnings\n1) Formato con paréntesis y suficientes palabras largas\n2) Segundo elemento con paréntesis y palabras suficientes\n',
  '## Learnings\n- 日本語の学習内容 は これ です たくさん の 単語\n',
  // Límites exactos: 3 palabras largas (rechazo), 4 palabras de 13 bytes (rechazo), 4 palabras y 20 bytes (admitido).
  '## Learnings\n- Reintentos exponenciales controlados\n- ab cd ef gh\n',
  '## Learnings\n- uno dos tres cuatros\n',
  '## Learnings\n- uno dos tres cuatro\n', // 19 bytes: rechazo
];

test('la captura pasiva extrae y guarda lo mismo que la referencia', { skip }, async () => {
  await save({ title: 'Semilla', content: 'observación previa', type: 'manual' });
  for (const [i, content] of PASSIVE.entries()) {
    const ref = await engram.call('mem_capture_passive', { content, source: 'subagent-stop' });
    assert.equal(ref.isError, false, ref.text);
    const [, extracted, saved, duplicates] = ref.json.result.match(/extracted=(\d+) saved=(\d+) duplicates=(\d+)/).map(Number);
    const mine = passiveCapture(odin, { session_id: SESSION, content, project: 'odin-memory', source: 'subagent-stop' });
    assert.deepEqual(mine, { extracted, saved, duplicates }, `caso ${i + 1}`);
  }
  const count = Number(odin.db.get("SELECT count(*) AS n FROM observations WHERE type = 'passive'").n);
  assert.ok(count >= 8, `se esperaban varios guardados, hubo ${count}`);
  // mismas observaciones, con el mismo título y contenido
  const total = Number(odin.db.get('SELECT count(*) AS n FROM observations').n);
  for (let id = 2; id <= total; id++) {
    const ref = await engram.call('mem_get_observation', { id });
    const body = ref.json.result;
    const head = body.indexOf('\n');
    const mine = getObservation(odin, id);
    assert.equal(mine.title, body.slice(body.indexOf('] ') + 2, head), `título #${id}`);
    assert.equal(mine.content, body.slice(head + 1, body.lastIndexOf('\nSession: ')), `contenido #${id}`);
    assert.equal(mine.type, 'passive');
  }
});

test('las estadísticas y el listado de proyectos coinciden', { skip }, async () => {
  const ref = await engram.call('mem_stats', {});
  const text = ref.json.result;
  const mine = stats(odin);
  assert.equal(Number(text.match(/Sessions: (\d+)/)[1]), mine.total_sessions);
  assert.equal(Number(text.match(/Observations: (\d+)/)[1]), mine.total_observations);
  assert.equal(Number(text.match(/Prompts: (\d+)/)[1]), mine.total_prompts);
  assert.equal(text.match(/Projects: (.*)$/m)[1], mine.projects.join(', '));

  const list = await engram.call('mem_list_projects', {});
  const [refProject] = list.json.projects;
  const [myProject] = listProjectsWithStats(odin);
  assert.deepEqual(
    { name: myProject.name, observation_count: myProject.observation_count, session_count: myProject.session_count, prompt_count: myProject.prompt_count },
    { name: refProject.name, observation_count: refProject.observation_count, session_count: refProject.session_count, prompt_count: refProject.prompt_count },
  );
});

test('el plan y el resultado de la consolidación coinciden', { skip }, async () => {
  const a = await save({ title: 'Cache de sesiones', content: 'usamos redis', type: 'manual' });
  const b = await save({ title: 'Cache de perfiles', content: 'también redis, con TTL', type: 'decision', topic_key: 'arq/cache' });
  const c = await save({ title: 'Cache de consultas', content: 'memoria local', type: 'config', scope: 'project' });

  const cases = [
    { ids: [a, b], args: { new_title: 'Cachés combinados', new_content: 'resumen de las cachés' } },
    { ids: [c, a, b], args: { new_title: 'Cachés', new_content: 'resumen\n\n\n', new_type: 'architecture', new_topic_key: 'Arq / Cachés' } },
  ];
  for (const { ids, args } of cases) {
    const planRef = await engram.call('mem_consolidate', { ids_to_delete: ids, ...(args.new_title && { new_title: args.new_title }), ...(args.new_content && { new_content: args.new_content }), ...(args.new_type && { type: args.new_type }), ...(args.new_topic_key && { topic_key: args.new_topic_key }), expected_project: 'odin-memory' });
    assert.equal(planRef.isError, false, planRef.text);
    const refPlan = planRef.json.plan;
    const { plan } = consolidateObservations(odin, {
      ids,
      overrides: { title: args.new_title, content: args.new_content, type: args.new_type, topic_key: args.new_topic_key },
      expected_project: 'odin-memory',
    });
    assert.deepEqual(plan.sources.map((s) => s.id), refPlan.sources.map((s) => s.id), 'orden de fuentes');
    const anon = (o) => ({ ...o, content: o.content.replace(/obs-[0-9a-f]+/g, 'obs-X') }); // los sync_id son aleatorios en cada lado
    assert.deepEqual(anon(plan.survivor), anon(refPlan.survivor), 'superviviente del plan');
    assert.equal(plan.project, refPlan.project);
  }

  // Confirmación de la primera combinación en ambos lados.
  const ids = [a, b];
  const base = { ids_to_delete: ids, new_title: 'Fusión final', new_content: 'contenido final', expected_project: 'odin-memory' };
  const planRef = await engram.call('mem_consolidate', base);
  const done = await engram.call('mem_consolidate', { ...base, confirm: true, fingerprint: planRef.json.plan.fingerprint });
  assert.equal(done.isError, false, done.text);
  const mineArgs = { ids, overrides: { title: 'Fusión final', content: 'contenido final' }, expected_project: 'odin-memory' };
  const { plan } = consolidateObservations(odin, mineArgs);
  const { survivor } = consolidateObservations(odin, { ...mineArgs, confirm: true, fingerprint: plan.fingerprint });
  const refSurvivor = done.json.survivor ?? done.json.observation ?? done.json;
  assert.equal(survivor.id, refSurvivor.id);
  assert.equal(survivor.title, refSurvivor.title);
  assert.equal(survivor.content.replace(/obs-[0-9a-f]+/g, 'obs-X'), refSurvivor.content.replace(/obs-[0-9a-f]+/g, 'obs-X'));
  assert.equal(getObservation(odin, a), null);
  assert.equal(getObservation(odin, b), null);
});
