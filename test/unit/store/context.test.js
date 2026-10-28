import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addObservation, addPrompt, createSession, endSession, formatCompactionContext, formatContext, historyPeriods,
  limitContextBytes, pinObservation, renderContextHistory,
} from '../../../src/store/index.js';
import { formatLocal, parseStored } from '../../../src/timeutil/index.js';
import { openTempStore } from './helpers.js';

const code = (c) => (err) => err.code === c;

function withTimezone(zone, fn) {
  const previous = process.env.ODIN_TIMEZONE;
  process.env.ODIN_TIMEZONE = zone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ODIN_TIMEZONE;
    else process.env.ODIN_TIMEZONE = previous;
  }
}

test('parseStored acepta el formato guardado (con o sin fracción) y RFC 3339', () => {
  assert.equal(parseStored('2026-10-27 22:00:00').toISOString(), '2026-10-27T22:00:00.000Z');
  assert.equal(parseStored('2026-10-27 22:00:00.123456789').toISOString(), '2026-10-27T22:00:00.000Z');
  assert.equal(parseStored('2026-10-27T22:00:00Z').toISOString(), '2026-10-27T22:00:00.000Z');
  assert.equal(parseStored('2026-10-27T22:00:00-03:00').toISOString(), '2026-10-28T01:00:00.000Z');
  assert.equal(parseStored('no es fecha'), null);
  assert.equal(parseStored('2026-10-27'), null);
});

test('formatLocal respeta ODIN_TIMEZONE y devuelve tal cual lo que no es fecha', () => {
  assert.equal(formatLocal('2026-10-27 22:00:00', { ODIN_TIMEZONE: 'UTC' }), '2026-10-27 22:00:00');
  assert.equal(formatLocal('2026-10-27 22:00:00', { ODIN_TIMEZONE: 'America/Santiago' }), '2026-10-27 19:00:00'); // UTC-3 (verano austral)
  assert.equal(formatLocal('2026-06-27 22:00:00', { ODIN_TIMEZONE: 'America/Santiago' }), '2026-06-27 18:00:00'); // UTC-4 (invierno)
  assert.equal(formatLocal('2026-10-27 23:30:00', { ODIN_TIMEZONE: 'Asia/Kolkata' }), '2026-10-28 05:00:00');
  assert.equal(formatLocal('2026-10-27 22:00:00.5', { ODIN_TIMEZONE: 'UTC' }), '2026-10-27 22:00:00');
  assert.equal(formatLocal('texto', { ODIN_TIMEZONE: 'UTC' }), 'texto');
  // una zona inválida cae a la hora local del proceso, sin lanzar
  assert.match(formatLocal('2026-10-27 22:00:00', { ODIN_TIMEZONE: 'No/Existe' }), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
});

test('historyPeriods: semanas de lunes a domingo, meses del trimestre y trimestres del año', () => {
  const periods = historyPeriods(new Date('2026-08-12T10:00:00Z')); // miércoles de agosto (tercer trimestre)
  assert.deepEqual(periods.map((p) => p.label), [
    '2026-08-31–2026-08-31', '2026-08-24–2026-08-30', '2026-08-17–2026-08-23', '2026-08-10–2026-08-16',
    '2026-08-03–2026-08-09', '2026-08-01–2026-08-02',
    '2026-07', '2026 Q2', '2026 Q1',
  ]);
  const current = periods.find((p) => p.label === '2026-08-10–2026-08-16');
  assert.equal(current.samples, 3);
  assert.equal(periods.find((p) => p.label === '2026-08-24–2026-08-30').samples, 1);
  assert.equal(periods.find((p) => p.label === '2026-07').monthly, true);
  assert.equal(periods.find((p) => p.label === '2026 Q1').samples, 0);
  // el 1 de enero no tiene meses de trimestre ni trimestres previos
  assert.deepEqual(historyPeriods(new Date('2026-01-01T00:00:00Z')).filter((p) => p.monthly || p.label.includes('Q')), []);
  // cada semana empieza en lunes salvo el primer tramo del mes
  for (const p of periods.filter((x) => !x.monthly && !x.label.includes('Q') && !x.label.startsWith('2026-08-01'))) {
    assert.equal(p.start.getUTCDay(), 1);
  }
});

test('limitContextBytes recorta por bytes con un marcador y sin partir caracteres', () => {
  assert.equal(limitContextBytes('hola', 0), 'hola');
  assert.equal(limitContextBytes('hola', 100), 'hola');
  assert.equal(limitContextBytes('a'.repeat(50), 30), `${'a'.repeat(17)}\n[truncated]\n`);
  assert.equal(limitContextBytes('a'.repeat(50), 5), 'aaaaa'); // menos que el marcador: solo prefijo
  assert.equal(limitContextBytes('éééé', 5), 'éé'); // 5 bytes caben dos 'é' (4 bytes)
  const cut = limitContextBytes('é'.repeat(30), 30);
  assert.ok(Buffer.byteLength(cut) <= 30);
  assert.ok(cut.endsWith('\n[truncated]\n'));
});

function setup(t, config = {}) {
  const store = openTempStore(t, config);
  createSession(store, 's1', 'proj', '/d');
  return store;
}
const save = (store, title, content, extra = {}) =>
  addObservation(store, { session_id: 's1', type: 'manual', title, content, ...extra }).id;

test('sin datos el contexto es una cadena vacía', (t) => {
  const store = openTempStore(t);
  assert.equal(formatContext(store, 'proj'), '');
});

test('formatContext: secciones, orden y formato', (t) => {
  const store = setup(t);
  endSession(store, 's1', 'Resumen de la sesión');
  const a = save(store, 'Fijada', 'contenido fijado', { type: 'decision' });
  save(store, 'Reciente', 'x'.repeat(400));
  addPrompt(store, { session_id: 's1', content: 'p'.repeat(250) });
  pinObservation(store, a);
  const text = withTimezone('UTC', () => formatContext(store, 'proj'));
  const lines = text.split('\n');
  assert.equal(lines[0], '## Memory from Previous Sessions');
  const headings = lines.filter((l) => l.startsWith('### '));
  assert.deepEqual(headings, ['### Recent Sessions', '### Recent User Prompts', '### Pinned', '### Recent Observations']);
  assert.match(text, /- \*\*proj\*\* \(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\): Resumen de la sesión \[2 observations\]\n/);
  assert.match(text, new RegExp(`- \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d: ${'p'.repeat(200)}\\.\\.\\.\\n`)); // prompt a 200 caracteres
  assert.match(text, /### Pinned\n- \[decision\] \*\*Fijada\*\*: contenido fijado\n/);
  assert.match(text, new RegExp(`### Recent Observations\\n- \\[manual\\] \\*\\*Reciente\\*\\*: ${'x'.repeat(300)}\\.\\.\\.\\n`)); // contenido a 300
  assert.ok(!text.includes('Fijada**: contenido fijado\n\n### Recent Observations\n- [decision]')); // la fijada no se repite
  assert.ok(text.endsWith('\n\n'));
});

test('formatContext: modo compacto, límites y omisión de secciones', (t) => {
  const store = setup(t);
  for (let i = 1; i <= 4; i++) save(store, `Obs ${i}`, `contenido ${i}`);
  addPrompt(store, { session_id: 's1', content: 'un prompt' });
  const compact = formatContext(store, 'proj', '', { compact: true });
  assert.match(compact, /- \[manual\] \*\*Obs 4\*\*\n/);
  assert.ok(!compact.includes('contenido 4'));
  const limited = formatContext(store, 'proj', '', { observations: 2, prompts: -1, sessions: -1, pinned: -1 });
  assert.deepEqual(limited.split('\n').filter((l) => l.startsWith('- ') || l.startsWith('### ')), [
    '### Recent Observations', '- [manual] **Obs 4**: contenido 4', '- [manual] **Obs 3**: contenido 3',
  ]);
  assert.equal(formatContext(store, 'proj', '', { observations: -1, prompts: -1, sessions: -1, pinned: -1 }), '');
  assert.equal(formatContext(store, 'otro-proyecto'), '');
  // el ámbito solo filtra observaciones: sin sesiones, prompts ni fijadas no queda nada
  assert.equal(formatContext(store, 'proj', 'global', { sessions: -1, prompts: -1, pinned: -1 }), '');
});

test('formatContext respeta max_bytes', (t) => {
  const store = setup(t);
  for (let i = 1; i <= 8; i++) save(store, `Observación número ${i}`, `contenido largo ${'z'.repeat(250)} ${i}`);
  const full = formatContext(store, 'proj');
  const limited = formatContext(store, 'proj', '', { max_bytes: 400 });
  assert.ok(Buffer.byteLength(limited) <= 400);
  assert.ok(limited.endsWith('\n[truncated]\n'));
  assert.ok(Buffer.byteLength(full) > 400);
});

test('historial antiguo: agrupa lo anterior a las recientes por periodo y año', (t) => {
  const NOW = new Date('2026-08-12T10:00:00Z');
  const store = setup(t, { now: () => NOW });
  const ids = [];
  const at = (title, when) => {
    const id = save(store, title, `contenido ${title}`);
    store.db.run('UPDATE observations SET created_at = ? WHERE id = ?', when, id);
    ids.push(id);
  };
  at('Semana actual 1', '2026-08-10 09:00:00');
  at('Semana actual 2', '2026-08-11 09:00:00');
  at('Semana actual 3', '2026-08-11 10:00:00');
  at('Semana actual 4', '2026-08-12 08:00:00');
  at('Semana previa', '2026-08-04 09:00:00');
  at('Julio A', '2026-07-03 09:00:00');
  at('Julio B', '2026-07-20 09:00:00');
  at('Segundo trimestre', '2026-05-15 09:00:00');
  at('Primer trimestre', '2026-02-15 09:00:00');
  at('Año anterior', '2025-06-01 09:00:00');
  at('Reciente 1', '2026-08-12 09:00:00');
  at('Reciente 2', '2026-08-12 09:30:00');

  const text = formatContext(store, 'proj', '', { older_history: true, observations: 2, sessions: -1, prompts: -1 });
  const [recent, older] = text.split('### Older History\n');
  assert.deepEqual(recent.split('\n').filter((l) => l.startsWith('- ')), [
    '- [manual] **Reciente 2**: contenido Reciente 2',
    '- [manual] **Reciente 1**: contenido Reciente 1',
  ]);
  const olderLines = older.split('\n');
  assert.equal(olderLines[0], 'Samples are titles, not summaries; use mem_get_observation with an ID to drill in.');
  const body = olderLines.slice(1).join('\n');
  assert.ok(body.includes('- 2026-08-10–2026-08-16: 4 observations\n'));
  assert.match(body, /  - Sample #\d+: Semana actual 4\n  - Sample #\d+: Semana actual 3\n  - Sample #\d+: Semana actual 2\n/); // 3 muestras, más recientes primero
  assert.ok(!body.includes('Semana actual 1\n  -')); // la cuarta no se muestra
  assert.ok(body.includes('- 2026-08-03–2026-08-09: 1 observations\n  - Sample #'));
  assert.ok(body.includes('- 2026-07: 2 observations (manual: 2)\n'));
  assert.ok(body.includes('- 2026 Q2: 1 observations\n'));
  assert.ok(body.includes('- 2026 Q1: 1 observations\n'));
  assert.ok(body.includes('- 2025: 1 observations\n'));
  assert.ok(body.indexOf('2026-08-10') < body.indexOf('2026-07') && body.indexOf('2026 Q1') < body.indexOf('2025: '));
  assert.ok(text.endsWith('\n\n'));
  // con presupuesto pequeño se omiten grupos
  const small = formatContext(store, 'proj', '', { older_history: true, observations: 2, sessions: -1, prompts: -1, max_bytes: 700 });
  assert.ok(Buffer.byteLength(small) <= 700 + 2048); // la parte antigua usa max/4 del presupuesto
  assert.ok(small.includes('### Older History'));
});

test('renderContextHistory: presupuesto, omisión y vacío', () => {
  const groups = [
    { label: 'A', count: 3, types: ['x: 3'], samples: ['  - Sample #1: uno\n'] },
    { label: 'B', count: 1, types: [], samples: [] },
    { label: 'C', count: 2, types: [], samples: [] },
  ];
  const full = renderContextHistory(groups, 10_000);
  assert.ok(full.startsWith('### Older History\nSamples are titles'));
  assert.ok(full.includes('- A: 3 observations (x: 3)\n  - Sample #1: uno\n- B: 1 observations\n- C: 2 observations\n'));
  assert.equal(renderContextHistory([], 10_000), '');
  assert.equal(renderContextHistory(groups, 10), ''); // no cabe ni la cabecera
  const header = Buffer.byteLength('### Older History\nSamples are titles, not summaries; use mem_get_observation with an ID to drill in.\n');
  const tight = renderContextHistory(groups, header + 60);
  assert.ok(Buffer.byteLength(tight) <= header + 60);
  assert.ok(tight.includes('- [older groups omitted]\n'));
  assert.equal(renderContextHistory(groups, header + 1), ''); // ninguna línea cabe
});

test('formatCompactionContext resume la sesión con sus fijadas, observaciones y prompts', (t) => {
  const store = setup(t);
  createSession(store, 's2', 'proj', '/d');
  const a = save(store, 'Fijada', 'detalle fijado');
  save(store, 'Normal', 'detalle normal');
  addObservation(store, { session_id: 's2', type: 'manual', title: 'Otra sesión', content: 'no debe salir' });
  addPrompt(store, { session_id: 's1', content: 'prompt de s1' });
  addPrompt(store, { session_id: 's2', content: 'prompt de s2' });
  pinObservation(store, a);
  endSession(store, 's1', 'Cerrada');
  const text = withTimezone('UTC', () => formatCompactionContext(store, 's1'));
  assert.ok(text.startsWith('## Memory from This Session\n\n### Session\n- **s1** ('));
  assert.match(text, /\): Cerrada \[2 observations\]\n\n/);
  assert.match(text, /### Recent User Prompts\n- \d{4}-\d\d-\d\d \d\d:\d\d:\d\d: prompt de s1\n\n/);
  assert.match(text, /### Pinned\n- \[manual\] \*\*Fijada\*\*: detalle fijado\n\n### Recent Observations\n- \[manual\] \*\*Normal\*\*: detalle normal\n\n$/);
  assert.ok(!text.includes('Otra sesión') && !text.includes('prompt de s2'));
  assert.throws(() => formatCompactionContext(store, 'no-existe'), code('session_not_found'));
});

test('readTransaction ve una instantánea y no deja la conexión en transacción', (t) => {
  const store = setup(t);
  save(store, 'Uno', 'x');
  const count = store.db.readTransaction((db) => {
    assert.equal(db.inTransaction, true);
    return Number(db.get('SELECT COUNT(*) AS n FROM observations').n);
  });
  assert.equal(count, 1);
  assert.equal(store.db.inTransaction, false);
  assert.throws(() => store.db.readTransaction(() => { throw new Error('x'); }), /x/);
  assert.equal(store.db.inTransaction, false);
  assert.throws(() => store.db.readTransaction(async () => 1), /síncrona/);
  assert.equal(store.db.inTransaction, false);
});
