import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSOLIDATED_FROM_MARKER, addObservation, consolidateObservations, createSession, getObservation, pinObservation,
  searchObservations,
} from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const code = (c) => (err) => err.code === c;

function setup(t) {
  const store = openTempStore(t);
  createSession(store, 's1', 'proj', '/d');
  createSession(store, 's2', 'proj', '/d');
  createSession(store, 'x', 'otro', '/d');
  const save = (title, content, extra = {}) =>
    addObservation(store, { session_id: 's1', type: 'manual', title, content, ...extra }).id;
  return { store, save };
}

test('sin confirmar devuelve el plan sin escribir nada', (t) => {
  const { store, save } = setup(t);
  const a = save('Primera', 'contenido uno');
  const b = save('Segunda', 'contenido dos', { type: 'decision' });
  const { plan, survivor } = consolidateObservations(store, { ids: [a, b] });
  assert.equal(survivor, undefined);
  assert.equal(plan.project, 'proj');
  assert.deepEqual(plan.sources.map((s) => s.id), [b, a]); // la más reciente primero
  assert.equal(plan.survivor.title, 'Segunda · Primera');
  assert.equal(plan.survivor.type, 'decision'); // hereda de la más reciente
  assert.equal(plan.survivor.content, `contenido dos\n\ncontenido uno\n\n${CONSOLIDATED_FROM_MARKER}\n- ${getObservation(store, b).sync_id}\n- ${getObservation(store, a).sync_id}\n`);
  assert.match(plan.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(store.db.get('SELECT count(*) AS n FROM observations').n, 2);
});

test('confirmar con la huella crea el superviviente y borra las fuentes enlazándolas', (t) => {
  const { store, save } = setup(t);
  const a = save('Primera', 'contenido uno');
  const b = save('Segunda', 'contenido dos');
  const { plan } = consolidateObservations(store, { ids: [a, b], overrides: { title: 'Fusionada', type: 'architecture', topic_key: 'Tema / Fusión' } });
  const { survivor } = consolidateObservations(store, {
    ids: [a, b], overrides: { title: 'Fusionada', type: 'architecture', topic_key: 'Tema / Fusión' }, confirm: true, fingerprint: plan.fingerprint,
  });
  assert.equal(survivor.title, 'Fusionada');
  assert.equal(survivor.type, 'architecture');
  assert.equal(survivor.topic_key, 'tema-/-fusión');
  assert.equal(survivor.tool_name, 'mem_consolidate');
  assert.equal(survivor.project, 'proj');
  assert.equal(survivor.session_id, 's1');
  assert.equal(survivor.revision_count, 1);
  assert.equal(getObservation(store, a), null);
  assert.equal(getObservation(store, b), null);
  const rows = store.db.all('SELECT id, deleted_at, superseded_by_sync_id FROM observations WHERE id IN (?, ?)', a, b);
  assert.ok(rows.every((r) => r.deleted_at && r.superseded_by_sync_id === survivor.sync_id));
  assert.equal(searchObservations(store, 'Fusionada').length, 1);
});

test('una huella obsoleta se rechaza y devuelve el plan nuevo', (t) => {
  const { store, save } = setup(t);
  const a = save('Primera', 'contenido uno');
  const b = save('Segunda', 'contenido dos');
  const { plan } = consolidateObservations(store, { ids: [a, b] });
  pinObservation(store, a); // cambia una fuente tras planificar
  assert.throws(
    () => consolidateObservations(store, { ids: [a, b], confirm: true, fingerprint: plan.fingerprint }),
    (err) => err.code === 'consolidate_fingerprint_mismatch' && err.plan.fingerprint !== plan.fingerprint,
  );
  assert.equal(getObservation(store, a).sync_id !== undefined, true); // nada cambió
  assert.throws(() => consolidateObservations(store, { ids: [a, b], confirm: true, fingerprint: '' }), code('consolidate_fingerprint_mismatch'));
});

test('validaciones de las fuentes', (t) => {
  const { store, save } = setup(t);
  const a = save('Primera', 'uno');
  const b = save('Segunda', 'dos');
  const x = addObservation(store, { session_id: 'x', type: 'manual', title: 'Ajena', content: 'tres' }).id;
  assert.throws(() => consolidateObservations(store, { ids: [a] }), code('consolidate_need_two_sources'));
  assert.throws(() => consolidateObservations(store, { ids: [] }), code('consolidate_need_two_sources'));
  assert.throws(() => consolidateObservations(store, { ids: [a, a] }), code('consolidate_duplicate_id'));
  assert.throws(() => consolidateObservations(store, { ids: [a, 999] }), code('consolidate_missing_observation'));
  assert.throws(() => consolidateObservations(store, { ids: [a, x] }), code('consolidate_cross_project'));
  assert.throws(() => consolidateObservations(store, { ids: [a, b], expected_project: 'otro' }), code('observation_project_mismatch'));
  assert.throws(() => consolidateObservations(store, { ids: [a, b], expected_project: ' ' }), code('expected_project_required'));
  assert.equal(consolidateObservations(store, { ids: [a, b], expected_project: 'PROJ' }).plan.project, 'proj');
});

test('detecta ciclos de procedencia', (t) => {
  const { store, save } = setup(t);
  const a = save('Primera', 'uno');
  const b = save('Segunda', 'dos');
  const syncA = getObservation(store, a).sync_id;
  // b declara a a como origen: fusionarlas formaría un ciclo
  store.db.run('UPDATE observations SET content = ? WHERE id = ?', `texto\n\n${CONSOLIDATED_FROM_MARKER}\n- ${syncA}\n`, b);
  assert.throws(() => consolidateObservations(store, { ids: [a, b] }), code('consolidate_provenance_cycle'));
});

test('consolidar un superviviente previo con otra fuente es válido (la procedencia se encadena)', (t) => {
  const { store, save } = setup(t);
  const [a, b, c] = [save('A', 'uno'), save('B', 'dos'), save('C', 'tres')];
  const first = consolidateObservations(store, { ids: [a, b] });
  const done = consolidateObservations(store, { ids: [a, b], confirm: true, fingerprint: first.plan.fingerprint });
  const second = consolidateObservations(store, { ids: [done.survivor.id, c] });
  assert.equal(second.plan.survivor.content.split(CONSOLIDATED_FROM_MARKER).length, 3); // dos secciones: la heredada y la nueva
  const final = consolidateObservations(store, { ids: [done.survivor.id, c], confirm: true, fingerprint: second.plan.fingerprint });
  assert.equal(final.survivor.project, 'proj');
});

test('el plan es determinista y cambia si cambian las sustituciones', (t) => {
  const { store, save } = setup(t);
  const a = save('Primera', 'uno');
  const b = save('Segunda', 'dos');
  const p1 = consolidateObservations(store, { ids: [a, b] }).plan.fingerprint;
  assert.equal(consolidateObservations(store, { ids: [b, a] }).plan.fingerprint, p1); // el orden de ids no importa
  assert.notEqual(consolidateObservations(store, { ids: [a, b], overrides: { title: 'Otro' } }).plan.fingerprint, p1);
});
