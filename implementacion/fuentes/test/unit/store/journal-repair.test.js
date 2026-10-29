import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupForeignSyncTargets, quarantineIrreparableSyncMutations, repairObservationMutationTitles, repairObservationSourceTitles, repairPendingSessionDirectories,
  repairSyncMutationRequiredFields, supersedeUnenrolledLegacyMutations,
} from '../../../src/store/journal-repair.js';
import { DiscardBlocker, applyLegacyEmptyPromptDiscard, planLegacyEmptyPromptDiscard } from '../../../src/store/prompt-discard.js';
import { applySessionIdentityRepair, planSessionIdentityRepair } from '../../../src/store/session-identity-repair.js';
import { addObservation, addPrompt, createSession, enrollProject } from '../../../src/store/index.js';
import { openTempStore } from './helpers.js';

const journal = (store, entity, key, payload, { project = 'demo', op = 'upsert', source = 'local' } = {}) => store.db.run(
  "INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project, source) VALUES ('cloud', ?, ?, ?, ?, ?, ?)", entity, key, op, typeof payload === 'string' ? payload : JSON.stringify(payload), project, source,
);
const first = (store) => store.db.get('SELECT MIN(seq) AS n FROM sync_mutations').n;
const rows = (store, sql = 'SELECT seq, entity, entity_key, disposition, payload FROM sync_mutations ORDER BY seq') => store.db.all(sql).map((r) => ({ ...r }));

function seeded(t) {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/work/demo');
  const { id } = addObservation(store, { session_id: 's1', type: 'decision', title: 'Usar pg', content: 'por fiable', project: 'demo' });
  const syncId = store.db.get('SELECT sync_id FROM observations WHERE id = ?', id).sync_id;
  enrollProject(store, 'demo');
  store.db.run('DELETE FROM sync_mutations');
  return { store, id, syncId };
}

test('el directorio de una sesión pendiente se rellena desde la sesión local', (t) => {
  const { store } = seeded(t);
  journal(store, 'session', 's1', { id: 's1', project: 'demo' });
  journal(store, 'session', 'sin-sesion', { id: 'sin-sesion', project: 'demo' });
  journal(store, 'observation', 'o', { sync_id: 'o' });
  journal(store, 'session', 's1', '[1]');
  assert.deepEqual(repairPendingSessionDirectories(store, 'otro', true), []);
  const plan = repairPendingSessionDirectories(store, 'demo', false);
  assert.deepEqual(plan.map((a) => [a.entity_key, a.project]), [['s1', 'demo']]);
  assert.equal(JSON.parse(rows(store)[0].payload).directory, undefined, 'el simulacro no escribe');
  repairPendingSessionDirectories(store, '', true);
  assert.equal(JSON.parse(rows(store)[0].payload).directory, '/work/demo');
  assert.deepEqual(repairPendingSessionDirectories(store, 'demo', true), []);
});

test('el título de una carga se restaura de la observación local o se deriva del contenido', (t) => {
  const { store, id, syncId } = seeded(t);
  const payload = (extra = {}) => ({ sync_id: syncId, session_id: 's1', type: 'decision', title: '', content: 'por fiable', scope: 'project', project: 'demo', ...extra });
  journal(store, 'observation', syncId, payload());
  const dry = repairObservationMutationTitles(store, 'demo', false);
  assert.deepEqual([dry.applied, dry.actions.map((a) => a.title)], [false, ['Usar pg']]);
  assert.equal(JSON.parse(rows(store)[0].payload).title, '');
  assert.deepEqual(repairObservationMutationTitles(store, 'otro', true).actions, []);
  repairObservationMutationTitles(store, 'demo', true);
  assert.equal(JSON.parse(rows(store)[0].payload).title, 'Usar pg');

  // Título local vacío: se deriva de la primera frase del contenido y se escribe también en la observación.
  store.db.run("UPDATE observations SET title = '', content = 'Primera frase. Segunda frase' WHERE id = ?", id);
  store.db.run('DELETE FROM sync_mutations');
  journal(store, 'observation', syncId, payload({ content: 'Primera frase. Segunda frase' }));
  repairObservationMutationTitles(store, 'demo', true);
  assert.equal(JSON.parse(rows(store)[0].payload).title, 'Primera frase.');
  assert.equal(store.db.get('SELECT title FROM observations WHERE id = ?', id).title, 'Primera frase.');

  // No se repara si otro campo contradice a la observación o falta algo más.
  for (const mutated of [payload({ session_id: 'otra' }), payload({ scope: 'personal' }), payload({ project: 'otro' }), payload({ sync_id: 'otro' }), payload({ content: '' }), { sync_id: syncId }]) {
    store.db.run('DELETE FROM sync_mutations');
    store.db.run("UPDATE observations SET title = 'Usar pg'");
    journal(store, 'observation', syncId, mutated);
    assert.deepEqual(repairObservationMutationTitles(store, 'demo', false).actions, [], JSON.stringify(mutated));
  }
  store.db.run('DELETE FROM sync_mutations');
  journal(store, 'observation', syncId, payload(), { source: 'remoto' });
  assert.deepEqual(repairObservationMutationTitles(store, 'demo', false).actions, [], 'solo las mutaciones locales');
  store.db.run('DELETE FROM sync_mutations');
  journal(store, 'observation', 'desconocida', payload({ sync_id: 'desconocida' }));
  assert.deepEqual(repairObservationMutationTitles(store, 'demo', false).actions, []);
});

test('las altas de proyectos sin inscribir se retiran solo con evidencia de borrado', (t) => {
  const { store, syncId } = seeded(t);
  store.db.run("DELETE FROM sync_enrolled_projects WHERE project = 'demo'");
  journal(store, 'observation', syncId, { sync_id: syncId });
  journal(store, 'observation', 'viva', { sync_id: 'viva' });
  store.db.run("INSERT INTO sync_delete_tombstones (entity, entity_key, project, deleted_at, hard_delete, active) VALUES ('observation', ?, 'demo', datetime('now'), 0, 1)", syncId);
  const dry = supersedeUnenrolledLegacyMutations(store, 'cloud', 'demo', false);
  assert.deepEqual(dry.actions.map((a) => [a.entity_key, a.reason_code]), [[syncId, 'local_entity_deleted']]);
  assert.deepEqual(supersedeUnenrolledLegacyMutations(store, 'cloud', 'otro', true).actions, []);
  supersedeUnenrolledLegacyMutations(store, 'cloud', '', true);
  assert.deepEqual(rows(store).map((r) => r.disposition), ['superseded', 'pending']);
  assert.deepEqual(JSON.parse(store.db.get('SELECT disposition_evidence AS e FROM sync_mutations ORDER BY seq LIMIT 1').e), { entity: 'observation', entity_key: syncId, project: 'demo', trigger: 'doctor_local_reconciliation' });
  // Un proyecto inscrito no se toca.
  enrollProject(store, 'demo');
  store.db.run("UPDATE sync_mutations SET disposition = 'pending', disposition_reason = NULL");
  store.db.run('UPDATE sync_delete_tombstones SET active = 1');
  assert.deepEqual(supersedeUnenrolledLegacyMutations(store, 'cloud', 'demo', true).actions, []);
  // Una lápida de borrado duro del proyecto, posterior a la mutación, retira las altas anteriores.
  store.db.run('DELETE FROM sync_enrolled_projects');
  store.db.run('DELETE FROM sync_delete_tombstones');
  store.db.run('DELETE FROM sync_mutations');
  journal(store, 'observation', syncId, { sync_id: syncId });
  journal(store, 'observation', 'viva', { sync_id: 'viva' });
  store.db.run("INSERT INTO sync_delete_tombstones (entity, entity_key, project, deleted_at, hard_delete, active) VALUES ('project', 'demo', 'demo', datetime('now', '+1 hour'), 1, 1)");
  assert.equal(supersedeUnenrolledLegacyMutations(store, 'cloud', 'demo', false).actions.length, 2);
  store.db.run("UPDATE sync_delete_tombstones SET hard_delete = 0");
  assert.equal(supersedeUnenrolledLegacyMutations(store, 'cloud', 'demo', false).actions.length, 0, 'sin borrado duro no hay evidencia');
  store.db.run("UPDATE sync_delete_tombstones SET hard_delete = 1, deleted_at = datetime('now', '-1 day')");
  assert.equal(supersedeUnenrolledLegacyMutations(store, 'cloud', 'demo', false).actions.length, 0, 'una lápida anterior no cubre un proyecto recreado');
});

test('lo irreparable pasa a cuarentena sin acusarse ni reescribirse', (t) => {
  const { store } = seeded(t);
  journal(store, 'widget', 'w', {});
  journal(store, 'prompt', 'p', { sync_id: 'p' });
  journal(store, 'observation', 'o', { sync_id: 'o' }, { project: 'otro' });
  const dry = quarantineIrreparableSyncMutations(store, 'cloud', 'demo', false);
  assert.deepEqual([dry.applied, dry.actions.map((a) => a.entity)], [false, ['widget', 'prompt']]);
  assert.deepEqual(JSON.parse(dry.actions[0].evidence), { check: 'sync_mutation_required_fields', finding: { seq: first(store), entity: 'widget', op: 'upsert', reason_code: 'upgrade_blocked_legacy_mutation_manual', message: 'unsupported legacy mutation "widget"/"upsert"', repairable: false, entity_key: 'w', target_key: 'cloud', project: 'demo' } });
  assert.equal(rows(store).every((r) => r.disposition === 'pending'), true);
  assert.deepEqual(quarantineIrreparableSyncMutations(store, 'cloud:inbox', 'demo', true).actions, []);
  const applied = quarantineIrreparableSyncMutations(store, 'cloud', 'demo', true);
  assert.equal(applied.actions.length, 2);
  assert.deepEqual(rows(store).map((r) => r.disposition), ['quarantined', 'quarantined', 'pending']);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_mutations WHERE acked_at IS NOT NULL").n, 0);
  assert.equal(store.db.get("SELECT lifecycle FROM sync_state WHERE target_key = 'cloud:demo'").lifecycle, 'healthy', 'el ciclo de vida se recalcula');
  assert.deepEqual(quarantineIrreparableSyncMutations(store, 'cloud', 'demo', true).actions, [], 'repetir no hace nada');
});

test('los títulos de origen se derivan de la primera línea y lo demás se informa como irreparable', (t) => {
  const { store } = seeded(t);
  const insert = (title, content, type = 'note') => store.db.run(
    "INSERT INTO observations (sync_id, session_id, type, title, content, project, scope) VALUES (?, 's1', ?, ?, ?, 'demo', 'project')", `obs-${Math.random().toString(16).slice(2)}`, type, title, content,
  );
  insert('', 'Una línea útil. Con más texto\nsegunda línea');
  insert('', '   ');
  insert('', 'contenido', '');
  const dry = repairObservationSourceTitles(store, 'demo', false);
  assert.deepEqual(dry.actions.map((a) => a.title), ['Una línea útil.', 'contenido']);
  assert.deepEqual(dry.unrepairable.map((u) => [u.missing_fields, u.reason.startsWith('Repair cannot reconstruct missing type or content')]), [[['title', 'content'], true], [['type'], true]]);
  assert.equal(dry.backup_path, undefined);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM observations WHERE title = ''").n, 3);
  const applied = repairObservationSourceTitles(store, 'demo', true);
  assert.ok(existsSync(applied.backup_path), 'copia previa');
  assert.equal(store.db.get("SELECT title FROM observations WHERE title LIKE 'Una línea%'").title, 'Una línea útil.');
  const queued = rows(store).find((r) => JSON.parse(r.payload).title === 'Una línea útil.');
  assert.equal(queued.entity, 'observation', 'se encola una alta con el título reparado');
  assert.equal(repairObservationSourceTitles(store, 'demo', true).actions.length, 0);
});

test('la orquestación aplica las cinco reparaciones y descuenta lo ya tratado en el simulacro', (t) => {
  const { store, syncId } = seeded(t);
  journal(store, 'session', 's1', { id: 's1', project: 'demo' });
  journal(store, 'widget', 'w', {});
  const dry = repairSyncMutationRequiredFields(store, 'demo', 'dry_run');
  assert.deepEqual([dry.directory_repairs.length, dry.quarantine.actions.map((a) => a.entity), dry.quarantine.applied], [1, ['widget'], false]);
  const applied = repairSyncMutationRequiredFields(store, '', 'apply');
  assert.equal(applied.quarantine.applied, true);
  assert.deepEqual(rows(store).map((r) => r.disposition), ['pending', 'quarantined']);
  assert.equal(repairSyncMutationRequiredFields(store, '', 'apply').quarantine.applied, false);
  assert.ok(syncId);
});

test('los destinos ajenos se reasignan o se borran según conserven filas', (t) => {
  const { store } = seeded(t);
  store.db.run("INSERT INTO sync_state (target_key, lifecycle) VALUES ('cloud:fantasma', 'idle'), ('otro', 'idle'), ('cloud:retenido', 'idle')");
  store.db.run("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud:fantasma', 'session', 's1', 'upsert', '{}', 'demo')");
  store.db.run("INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project, acked_at) VALUES ('cloud:retenido', 'session', 's1', 'upsert', '{}', 'demo', datetime('now'))");
  const dry = cleanupForeignSyncTargets(store, false);
  assert.deepEqual(dry.actions, [
    { target_key: 'cloud:fantasma', retargeted_mutations: 1, retained_mutations: 0, state_removed: true },
    { target_key: 'cloud:retenido', retargeted_mutations: 0, retained_mutations: 1, state_removed: false },
    { target_key: 'otro', retargeted_mutations: 0, retained_mutations: 0, state_removed: true },
  ]);
  assert.equal(dry.applied, false);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sync_state WHERE target_key = 'otro'").n, 1);
  const applied = cleanupForeignSyncTargets(store, true);
  assert.equal(applied.applied, true);
  assert.deepEqual(store.db.all('SELECT target_key FROM sync_state ORDER BY target_key').map((r) => r.target_key).filter((k) => !['cloud', 'cloud:demo', 'cloud:inbox'].includes(k)), ['cloud:retenido']);
  assert.equal(store.db.get("SELECT target_key FROM sync_mutations WHERE entity_key = 's1' AND acked_at IS NULL").target_key, 'cloud', 'la fila pendiente vuelve al destino global');
  assert.equal(cleanupForeignSyncTargets(store, true).applied, false);
});

// ─── Identidad de sesión ─────────────────────────────────────────────────────

function blankSession(t, { enrolled = true } = {}) {
  const { store, id, syncId } = seeded(t);
  if (!enrolled) store.db.run('DELETE FROM sync_enrolled_projects');
  store.db.run('PRAGMA foreign_keys = OFF');
  store.db.run("INSERT INTO sessions (id, project, directory, started_at) VALUES (' ', 'demo', '/work/demo', '2026-01-01 00:00:00')");
  store.db.run("UPDATE observations SET session_id = ' '");
  const { id: promptId } = addPrompt(store, { session_id: 's1', content: 'hola', project: 'demo' });
  store.db.run("UPDATE user_prompts SET session_id = ' ' WHERE id = ?", promptId);
  store.db.run('DELETE FROM sync_mutations');
  return { store, id, syncId };
}

test('la identidad en blanco se sustituye migrando lo que cuelga de ella y publicando lo corregido', (t) => {
  const { store, syncId } = blankSession(t);
  journal(store, 'session', ' ', { id: ' ', project: 'demo', directory: '/work/demo' });
  journal(store, 'observation', syncId, { sync_id: syncId, session_id: ' ', project: 'demo' });
  const plan = planSessionIdentityRepair(store, ' ', 'canonica');
  assert.deepEqual({ ...plan }, { source_id: ' ', replacement_id: 'canonica', project: 'demo', observations: 1, prompts: 1, retired_mutations: 2, enrolled: true });
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM sessions WHERE id = 'canonica'").n, 0, 'planificar no escribe');
  const result = applySessionIdentityRepair(store, plan);
  assert.equal(result.published_mutations, 3);
  assert.ok(existsSync(result.backup_path));
  assert.deepEqual(store.db.all('SELECT id FROM sessions ORDER BY id').map((r) => r.id), ['canonica', 's1']);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM observations WHERE session_id = 'canonica'").n, 1);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM user_prompts WHERE session_id = 'canonica'").n, 1);
  const journalRows = rows(store);
  assert.deepEqual(journalRows.map((r) => r.disposition), ['superseded', 'superseded', 'pending', 'pending', 'pending']);
  assert.deepEqual(journalRows.slice(2).map((r) => r.entity), ['session', 'observation', 'prompt']);
  assert.equal(store.db.get('SELECT disposition_evidence AS e FROM sync_mutations ORDER BY seq LIMIT 1').e, 'replacement_id="canonica"');
  assert.throws(() => applySessionIdentityRepair(store, plan), /invalid session identity repair IDs|session identity source/, 'el plan ya no vale');
});

test('sin inscribir no se publica nada y el plan caduca si la evidencia cambia', (t) => {
  const { store } = blankSession(t, { enrolled: false });
  const plan = planSessionIdentityRepair(store, ' ', 'canonica');
  assert.equal(plan.enrolled, false);
  store.db.run("UPDATE observations SET title = 'cambiado'");
  assert.throws(() => applySessionIdentityRepair(store, plan), /evidence changed since plan/);
  const fresh = planSessionIdentityRepair(store, ' ', 'canonica');
  assert.equal(applySessionIdentityRepair(store, fresh).published_mutations, 0);
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM sync_mutations').n, 0);
  assert.throws(() => applySessionIdentityRepair(store, { ...fresh }), /requires a store plan/);
});

test('cada riesgo de la sustitución de identidad la bloquea', (t) => {
  const { store, syncId } = blankSession(t);
  const blocked = (pattern, replacement = 'canonica', source = ' ') => assert.throws(() => planSessionIdentityRepair(store, source, replacement), pattern);
  blocked(/invalid session identity repair IDs/, 'x', 's1');
  blocked(/invalid session identity repair IDs/, ' ');
  blocked(/invalid session identity repair IDs/, ' ', ' ');
  blocked(/session identity source: sql: no rows/, 'x', '\t');
  blocked(/replacement session identity already exists/, 's1');
  store.db.run("UPDATE sessions SET directory = '' WHERE id = ' '");
  blocked(/lacks canonical project or directory/);
  store.db.run("UPDATE sessions SET directory = '/work/demo', project = 'Demo' WHERE id = ' '");
  blocked(/lacks canonical project or directory/);
  store.db.run("UPDATE sessions SET project = 'demo' WHERE id = ' '");
  store.db.run("UPDATE observations SET project = 'otro'");
  blocked(/unsafe observation source/);
  store.db.run("UPDATE observations SET project = 'demo'");
  store.db.run("UPDATE user_prompts SET project = 'otro' WHERE session_id = ' '");
  blocked(/unsafe prompt source/);
  store.db.run("UPDATE user_prompts SET project = 'demo' WHERE session_id = ' '");
  store.db.run("INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status, marked_by_actor, marked_by_kind, session_id) VALUES ('rel-1', 'a', 'b', 'related', 'judged', 'x', 'human', ' ')");
  blocked(/relation references/);
  store.db.run('DELETE FROM memory_relations');
  store.db.run("INSERT INTO prompt_tombstones (sync_id, session_id, project) VALUES ('t', ' ', 'demo')");
  blocked(/blocked by prompt tombstones/);
  store.db.run('DELETE FROM prompt_tombstones');
  journal(store, 'observation', syncId, '{', {});
  blocked(/ambiguous observation mutation/);
  store.db.run('DELETE FROM sync_mutations');
  journal(store, 'observation', syncId, '{"sync_id":"x","session_id":" ","session_id":" "}');
  blocked(/shadowed source identity/);
  store.db.run('DELETE FROM sync_mutations');
  journal(store, 'observation', syncId, { sync_id: syncId, session_id: ' ', project: 'demo' }, { source: 'remoto' });
  blocked(/unsafe linked mutation/);
  store.db.run('DELETE FROM sync_mutations');
  journal(store, 'relation', 'r', { sync_id: 'r', session_id: ' ' });
  blocked(/linked relation mutation \d+ cannot be repaired/);
  store.db.run('DELETE FROM sync_mutations');
  assert.equal(planSessionIdentityRepair(store, ' ', 'canonica').observations, 1, 'sin bloqueos el plan sale');
});

// ─── Descarte de prompt vacío ────────────────────────────────────────────────

function emptyPrompt(t) {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/work/demo');
  enrollProject(store, 'demo');
  store.db.run("INSERT INTO user_prompts (sync_id, session_id, content, project, source_inbox_id, local_creation_session_id, local_creation_inbox_id, local_creation_project) VALUES ('p-vacio', 's1', '', 'demo', 'in-1', 's1', 'in-1', 'demo')");
  store.db.run('DELETE FROM sync_mutations');
  const upsert = (content = '', extra = {}) => journal(store, 'prompt', 'p-vacio', { sync_id: 'p-vacio', session_id: 's1', content, project: 'demo', source_inbox_id: 'in-1', ...extra });
  upsert();
  upsert(' ');
  return { store, upsert };
}

test('el descarte de un prompt vacío exige un origen exacto y deja una única baja', (t) => {
  const { store } = emptyPrompt(t);
  const dir = mkdtempSync(join(tmpdir(), 'odin-discard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = first(store);
  const plan = planLegacyEmptyPromptDiscard(store, 'demo', base);
  assert.deepEqual([plan.sync_id, plan.session_id, plan.source_inbox_id, plan.sequences], ['p-vacio', 's1', 'in-1', [base, base + 1]]);
  assert.throws(() => applyLegacyEmptyPromptDiscard(store, plan, ''), (e) => e.code === 'backup_path_required');
  assert.throws(() => applyLegacyEmptyPromptDiscard(store, plan, join(dir, 'no-existe', 'b.db')), /resolve backup parent/);
  const result = applyLegacyEmptyPromptDiscard(store, plan, join(dir, 'copia.db'));
  assert.deepEqual([result.status, result.sequences, result.backup_path], ['delete_queued', [base, base + 1], join(realpathSync(dir), 'copia.db')]);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM user_prompts WHERE sync_id = 'p-vacio'").n, 0);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM prompt_tombstones WHERE sync_id = 'p-vacio'").n, 1);
  assert.deepEqual(rows(store).map((r) => [r.disposition, r.entity]), [['superseded', 'prompt'], ['superseded', 'prompt'], ['pending', 'prompt']]);
  const del = JSON.parse(rows(store)[2].payload);
  assert.deepEqual([del.deleted, del.hard_delete, del.sync_id, del.source_inbox_id, del.content], [true, true, 'p-vacio', 'in-1', '']);
  assert.equal(result.delete_seq, base + 2);
  assert.throws(() => applyLegacyEmptyPromptDiscard(store, plan, join(dir, 'otra.db')), (e) => e.code === 'stale_plan');
  assert.throws(() => applyLegacyEmptyPromptDiscard(store, plan, join(dir, 'copia.db')), (e) => e.code === 'stale_plan', 'el plan se revalida antes de crear la copia');
});

test('cada condición del descarte se informa con su código', (t) => {
  const { store, upsert } = emptyPrompt(t);
  const code = (project, seq) => {
    try {
      planLegacyEmptyPromptDiscard(store, project, seq);
    } catch (err) {
      assert.ok(err instanceof DiscardBlocker);
      return err.code;
    }
    return 'ok';
  };
  const n = first(store);
  assert.equal(code('Demo', n), 'invalid_selection');
  assert.equal(code('demo', 0), 'invalid_selection');
  assert.equal(code('demo', 99), 'missing_mutation');
  assert.equal(code('otro', n), 'not_enrolled');
  assert.equal(code('demo', n), 'ok');
  store.db.run("UPDATE user_prompts SET content = 'texto'");
  assert.equal(code('demo', n), 'recoverable_content');
  store.db.run("UPDATE user_prompts SET content = ''");
  store.db.run("UPDATE user_prompts SET local_creation_project = 'otro'");
  assert.equal(code('demo', n), 'conflicting_provenance');
  store.db.run("UPDATE user_prompts SET local_creation_project = 'demo'");
  store.db.run("UPDATE sessions SET local_creation_project = 'otro'");
  assert.equal(code('demo', n), 'conflicting_session');
  store.db.run("UPDATE sessions SET local_creation_project = NULL");
  store.db.run("INSERT INTO prompt_tombstones (sync_id, session_id, project) VALUES ('p-vacio', 's1', 'demo')");
  assert.equal(code('demo', n), 'prior_tombstone');
  store.db.run('DELETE FROM prompt_tombstones');
  upsert('contenido recuperable');
  assert.equal(code('demo', n), 'recoverable_content');
  store.db.run('DELETE FROM sync_mutations WHERE seq > ?', n + 1);
  upsert('', { extra: 1 });
  assert.equal(code('demo', n), 'malformed_payload');
  store.db.run('DELETE FROM sync_mutations WHERE seq > ?', n + 1);
  upsert('', { session_id: 'otra' });
  assert.equal(code('demo', n), 'conflicting_payload_identity');
  store.db.run('DELETE FROM sync_mutations WHERE seq > ?', n + 1);
  store.db.run("UPDATE sync_mutations SET disposition = 'quarantined' WHERE seq = ?", n + 1);
  assert.equal(code('demo', n), 'unsupported_lineage');
  store.db.run("UPDATE sync_mutations SET disposition = 'pending'");
});
