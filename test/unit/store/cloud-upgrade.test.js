import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPAIR_CLASS, UPGRADE_REASON, UPGRADE_STAGE, canRollbackUpgrade, captureUpgradeSnapshot, diagnoseLegacyMutations, readUpgradeState, remirrorProject, repairUpgrade, rollbackUpgrade, saveUpgradeState,
} from '../../../src/store/cloud-upgrade.js';
import { addObservation, addPrompt, createSession, enrollProject } from '../../../src/store/index.js';
import { isProjectEnrolled } from '../../../src/store/sync-state.js';
import { openTempStore } from './helpers.js';

const journal = (store, entity, key, payload, { project = 'demo', op = 'upsert' } = {}) => store.db.run(
  "INSERT INTO sync_mutations (target_key, entity, entity_key, op, payload, project) VALUES ('cloud', ?, ?, ?, ?, ?)", entity, key, op, typeof payload === 'string' ? payload : JSON.stringify(payload), project,
);
const clearJournal = (store) => store.db.run('DELETE FROM sync_mutations');
const payloads = (store) => store.db.all('SELECT entity, entity_key, project, payload FROM sync_mutations ORDER BY seq').map((r) => ({ ...r, payload: JSON.parse(r.payload) }));

function seeded(t) {
  const store = openTempStore(t);
  createSession(store, 's1', 'demo', '/work/demo');
  const { sync_id: obsId } = store.db.get('SELECT sync_id FROM observations WHERE id = ?', addObservation(store, { session_id: 's1', type: 'decision', title: 'Usar pg', content: 'por fiable', project: 'demo' }).id);
  const { sync_id: promptId } = store.db.get('SELECT sync_id FROM user_prompts WHERE id = ?', addPrompt(store, { session_id: 's1', content: 'hola', project: 'demo', source_inbox_id: 'in1' }).id);
  enrollProject(store, 'demo');
  clearJournal(store);
  return { store, obsId, promptId };
}

test('el estado por etapas se guarda, normaliza y conserva la instantánea capturada', (t) => {
  const store = openTempStore(t);
  assert.equal(readUpgradeState(store, 'demo'), null);
  assert.equal(readUpgradeState(store, '  '), null);
  assert.throws(() => saveUpgradeState(store, { project: ' ' }), /cloud upgrade project must not be empty/);
  saveUpgradeState(store, { project: 'Demo', stage: 'DOCTOR_READY', repair_class: 'Ready', last_error_code: 'c', last_error_message: 'm', snapshot: { captured: true, project_enrolled: true } });
  const state = readUpgradeState(store, 'demo');
  assert.deepEqual([state.project, state.stage, state.repair_class, state.last_error_code, state.last_error_message, state.snapshot], ['demo', 'doctor_ready', 'ready', 'c', 'm', { captured: true, project_enrolled: true }]);
  saveUpgradeState(store, { project: 'demo', stage: 'rara', repair_class: 'rara' });
  const next = readUpgradeState(store, 'demo');
  assert.deepEqual([next.stage, next.repair_class, next.snapshot], ['planned', 'none', { captured: true, project_enrolled: true }], 'etapa y clase desconocidas se normalizan y la instantánea capturada no se pierde');
  assert.equal(next.last_error_code, '');
});

test('la instantánea previa al arranque se captura una vez y rechaza puntos de control inseguros', (t) => {
  const store = openTempStore(t);
  assert.throws(() => captureUpgradeSnapshot(store, ' '), /cloud upgrade bootstrap requires project/);
  enrollProject(store, 'demo');
  const first = captureUpgradeSnapshot(store, 'Demo');
  assert.deepEqual([first.project, first.state.snapshot, first.state.stage], ['demo', { captured: true, project_enrolled: true }, 'planned']);
  store.db.run("DELETE FROM sync_enrolled_projects WHERE project = 'demo'");
  assert.deepEqual(captureUpgradeSnapshot(store, 'demo').state.snapshot, { captured: true, project_enrolled: true }, 'no se vuelve a capturar');
  for (const stage of ['bootstrap_enrolled', 'bootstrap_pushed', 'bootstrap_verified']) {
    store.db.run("UPDATE cloud_upgrade_state SET stage = ?, snapshot_json = '{\"captured\":false,\"project_enrolled\":false}' WHERE project = 'demo'", stage);
    assert.throws(() => captureUpgradeSnapshot(store, 'demo'), /bootstrap checkpoint requires a captured pre-bootstrap snapshot/, stage);
  }
});

test('volver atrás restaura la inscripción de la instantánea y no admite lo verificado', (t) => {
  const store = openTempStore(t);
  assert.equal(canRollbackUpgrade(store, 'demo'), false);
  assert.throws(() => rollbackUpgrade(store, ' '), /cloud upgrade rollback requires project/);
  assert.throws(() => rollbackUpgrade(store, 'demo'), /rollback requires existing upgrade checkpoint state/);
  saveUpgradeState(store, { project: 'demo', stage: 'doctor_ready' });
  assert.equal(canRollbackUpgrade(store, 'demo'), false, 'sin instantánea');
  assert.throws(() => rollbackUpgrade(store, 'demo'), /rollback requires a captured pre-bootstrap snapshot/);
  saveUpgradeState(store, { project: 'demo', stage: 'bootstrap_pushed', repair_class: 'repairable', last_error_code: 'x', last_error_message: 'y', findings_json: 'f', applied_actions: 'a', snapshot: { captured: true, project_enrolled: false } });
  enrollProject(store, 'demo');
  assert.equal(canRollbackUpgrade(store, 'demo'), true);
  const back = rollbackUpgrade(store, 'demo');
  assert.deepEqual([back.stage, back.last_error_code, back.findings_json, back.applied_actions, isProjectEnrolled(store, 'demo')], ['rolled_back', '', '', '', false]);
  saveUpgradeState(store, { project: 'demo', stage: 'rolled_back', snapshot: { captured: true, project_enrolled: true } });
  store.db.run("UPDATE cloud_upgrade_state SET snapshot_json = '{\"captured\":true,\"project_enrolled\":true}'");
  rollbackUpgrade(store, 'demo');
  assert.equal(isProjectEnrolled(store, 'demo'), true, 'si estaba inscrito se vuelve a inscribir');
  store.db.run("UPDATE cloud_upgrade_state SET stage = 'bootstrap_verified'");
  assert.equal(canRollbackUpgrade(store, 'demo'), false);
  assert.throws(() => rollbackUpgrade(store, 'demo'), /rollback is unavailable post-bootstrap; use explicit disconnect\/unenroll flows/);
});

test('el diagnóstico completa de la tabla local lo que a la carga le falta y bloquea lo irreparable', (t) => {
  const { store, obsId, promptId } = seeded(t);
  assert.deepEqual(diagnoseLegacyMutations(store, ' '), { project: '', repairable_count: 0, blocked_count: 0, findings: [] });
  assert.deepEqual(diagnoseLegacyMutations(store, 'demo'), { project: 'demo', repairable_count: 0, blocked_count: 0, findings: [] });

  journal(store, 'session', 's1', { id: 's1' }); // directorio de la tabla local
  journal(store, 'observation', obsId, { sync_id: obsId });
  journal(store, 'prompt', promptId, { sync_id: promptId });
  journal(store, 'observation', 'sin-clave', {}, { op: 'delete' }); // se reconstruye desde la clave
  let report = diagnoseLegacyMutations(store, 'demo');
  assert.deepEqual([report.repairable_count, report.blocked_count], [4, 0]);
  assert.deepEqual(report.findings.map((f) => [f.entity, f.repairable, f.reason_code]), [
    ['session', true, UPGRADE_REASON.repairableLegacyPayload], ['observation', true, UPGRADE_REASON.repairableLegacyPayload], ['prompt', true, UPGRADE_REASON.repairableLegacyPayload], ['observation', true, UPGRADE_REASON.repairableLegacyPayload],
  ]);
  assert.match(report.findings[0].repair_hint, /session id\/directory/);

  const dry = repairUpgrade(store, 'demo', false);
  assert.deepEqual([dry.class, dry.reason_code, dry.planned_action, dry.applied], [REPAIR_CLASS.repairable, UPGRADE_REASON.repairableLegacyPayload, 'repair_legacy_mutation_payloads', false]);
  assert.equal(readUpgradeState(store, 'demo'), null, 'el simulacro no deja estado');
  const before = JSON.stringify(payloads(store));
  repairUpgrade(store, 'demo', false);
  assert.equal(JSON.stringify(payloads(store)), before);

  const applied = repairUpgrade(store, 'demo', true);
  assert.deepEqual([applied.applied, applied.message], [true, 'applied deterministic legacy mutation payload repairs for project "demo"']);
  assert.equal(readUpgradeState(store, 'demo').stage, UPGRADE_STAGE.repairApplied);
  const [session, observation, prompt, deleted] = payloads(store);
  assert.deepEqual([session.payload.directory, session.payload.id], ['/work/demo', 's1']);
  assert.deepEqual([observation.payload.session_id, observation.payload.type, observation.payload.title, observation.payload.content, observation.payload.scope], ['s1', 'decision', 'Usar pg', 'por fiable', 'project']);
  assert.deepEqual([prompt.payload.session_id, prompt.payload.content, prompt.payload.source_inbox_id], ['s1', 'hola', 'in1']);
  assert.deepEqual([deleted.payload.sync_id], ['sin-clave']);
  report = diagnoseLegacyMutations(store, 'demo');
  assert.deepEqual([report.repairable_count, report.blocked_count], [0, 0], 'tras reparar no queda nada');
  assert.equal(repairUpgrade(store, 'demo', true).reason_code, UPGRADE_REASON.repairNoop);
});

test('cada tipo de carga irreparable se bloquea con su motivo', (t) => {
  const { store } = seeded(t);
  const blocked = (entity, key, payload, options) => {
    clearJournal(store);
    journal(store, entity, key, payload, options);
    const report = diagnoseLegacyMutations(store, 'demo');
    assert.deepEqual([report.blocked_count, report.repairable_count], [1, 0], `${entity}/${key}: ${JSON.stringify(report.findings)}`);
    return report.findings[0].message;
  };
  assert.equal(blocked('observation', 'o', ''), 'legacy mutation payload is empty');
  assert.equal(blocked('widget', 'w', '{}'), 'unsupported legacy mutation "widget"/"upsert"');
  assert.equal(blocked('relation', 'r', '{}', { op: 'delete' }), 'unsupported legacy mutation "relation"/"delete"');
  assert.match(blocked('session', 's1', '[1]'), /^decode session payload: json: cannot unmarshal array into Go value of type store\.syncSessionPayload$/);
  assert.match(blocked('observation', 'o', '{'), /^decode observation payload: /);
  assert.match(blocked('prompt', 'p', '"x"'), /cannot unmarshal string into Go value of type store\.syncPromptPayload/);
  assert.match(blocked('relation', 'r', 'true'), /cannot unmarshal bool into Go value of type store\.syncRelationPayload/);
  assert.equal(blocked('session', 's1', { id: 'otra' }), 'session entity_key "s1" does not match payload id "otra"');
  assert.equal(blocked('session', 'nuevo', { id: 'nuevo' }), 'session payload directory is required and cannot be inferred from local state');
  assert.equal(blocked('observation', 'o', { sync_id: 'otra' }), 'observation entity_key "o" does not match payload sync_id "otra"');
  assert.equal(blocked('observation', 'o', { sync_id: 'o' }), 'observation payload missing required upsert fields: session_id, type, title, content, scope');
  assert.equal(blocked('prompt', 'p', { sync_id: 'otra' }), 'prompt entity_key "p" does not match payload sync_id "otra"');
  assert.equal(blocked('prompt', 'p', { sync_id: 'p' }), 'prompt payload missing required upsert fields: session_id, content');
  assert.equal(blocked('relation', 'r', { sync_id: 'otra' }), 'relation entity_key "r" does not match payload sync_id "otra"');
  assert.equal(blocked('relation', 'r', { sync_id: 'r' }), 'relation payload missing required upsert fields: source_id, target_id, relation, judgment_status, marked_by_actor, marked_by_kind');
  assert.equal(blocked('session', 's1', { id: 's1', ownership_mode: 'project_owned', directory: 5 }), 'pulled session directory is invalid: directory must be a string');
  assert.equal(blocked('observation', 'o', { sync_id: 'o', project: 5 }), 'observation payload missing required upsert fields: session_id, type, title, content, scope');
  clearJournal(store);
  journal(store, 'observation', 'o', { sync_id: 'o' }, { project: '' });
  assert.equal(diagnoseLegacyMutations(store, 'demo').findings.length, 0, 'solo las sesiones sin dueño se atribuyen a un proyecto');
  // sin sesión local que la atribuya
  clearJournal(store);
  journal(store, 'session', 'sin-sesion', { id: 'sin-sesion', directory: '/x' }, { project: '' });
  assert.equal(diagnoseLegacyMutations(store, 'demo').findings.length, 0, 'ni la sesión local ni la carga la atribuyen a este proyecto');
  clearJournal(store);
  journal(store, 'session', 'sin-sesion', { id: 'sin-sesion', directory: '/x', project: 'demo' }, { project: '' });
  assert.match(diagnoseLegacyMutations(store, 'demo').findings[0].message, /cannot be inferred from authoritative local state/);
  clearJournal(store);
  journal(store, 'session', 's1', { id: 's1', project: 'otro' }, { project: '' });
  assert.equal(diagnoseLegacyMutations(store, 'demo').findings[0].message, 'session payload project conflicts with local session project');
  clearJournal(store);
  journal(store, 'session', 's1', { id: 's1', project: 'demo', directory: '/otro' }, { project: '' });
  assert.equal(diagnoseLegacyMutations(store, 'demo').findings[0].message, 'session payload directory conflicts with local session directory');
});

test('las relaciones se completan desde la tabla local y las demás reparaciones tienen su motivo', (t) => {
  const { store, obsId } = seeded(t);
  store.db.run(
    `INSERT INTO memory_relations (sync_id, source_id, target_id, relation, judgment_status, marked_by_actor, marked_by_kind, reason, confidence, session_id)
     VALUES ('rel-1', ?, 'obs-b', 'related', 'judged', 'ana', 'human', 'porque', 0.5, 's1')`,
    obsId,
  );
  journal(store, 'relation', 'rel-1', { sync_id: 'rel-1' });
  const report = diagnoseLegacyMutations(store, 'demo');
  assert.deepEqual([report.repairable_count, report.blocked_count], [1, 0]);
  repairUpgrade(store, 'demo', true);
  const { payload } = payloads(store)[0];
  assert.deepEqual([payload.source_id, payload.target_id, payload.relation, payload.judgment_status, payload.marked_by_actor, payload.marked_by_kind, payload.reason, payload.confidence, payload.session_id, payload.project],
    [obsId, 'obs-b', 'related', 'judged', 'ana', 'human', 'porque', 0.5, 's1', 'demo']);

  // Proyecto vacío y sin inscribir.
  assert.deepEqual(repairUpgrade(store, ' ', true), { class: 'blocked', reason_code: UPGRADE_REASON.blockedProjectRequired, message: 'project is required for cloud upgrade repair', applied: false });
  const unenrolled = repairUpgrade(store, 'otro', false);
  assert.deepEqual([unenrolled.class, unenrolled.reason_code, unenrolled.message], ['blocked', UPGRADE_REASON.blockedManual, 'project "otro" is not enrolled; run doctor/bootstrap guidance first']);
  // Estados de política que exigen una acción manual.
  for (const [reason, code] of [['auth_required', 'upgrade_policy_auth_required'], ['policy_forbidden', 'upgrade_policy_forbidden'], ['cloud_config_error', 'upgrade_policy_cloud_config_error']]) {
    store.db.run("INSERT OR REPLACE INTO sync_state (target_key, lifecycle, reason_code, reason_message) VALUES ('cloud:demo', 'degraded', ?, '')", reason);
    const policy = repairUpgrade(store, 'demo', true);
    assert.deepEqual([policy.class, policy.reason_code, policy.message], ['policy', code, 'manual-action-required: cloud policy/auth precondition must be resolved before repair'], reason);
  }
  store.db.run("UPDATE sync_state SET reason_code = 'transport_failed', reason_message = 'otra cosa' WHERE target_key = 'cloud:demo'");
  assert.notEqual(repairUpgrade(store, 'demo', false).class, 'policy');
  store.db.run("UPDATE sync_state SET reason_message = 'detalle' , reason_code = 'auth_required' WHERE target_key = 'cloud:demo'");
  assert.equal(repairUpgrade(store, 'demo', false).message, 'manual-action-required: detalle');
});

test('el simulacro y la aplicación cuentan lo reparable y lo que sigue bloqueado', (t) => {
  const { store, obsId } = seeded(t);
  journal(store, 'observation', obsId, { sync_id: obsId });
  journal(store, 'prompt', 'p-sin-datos', { sync_id: 'p-sin-datos' });
  const dry = repairUpgrade(store, 'demo', false);
  assert.deepEqual([dry.class, dry.reason_code, dry.applied], ['blocked', UPGRADE_REASON.blockedLegacyManual, false]);
  assert.match(dry.message, /^1 repairable payload\(s\) would apply; 1 would remain blocked: manual-action-required: prompt payload missing required upsert fields: session_id, content \(seq=\d+ entity=prompt entity_key="p-sin-datos" op=upsert\)$/);
  const applied = repairUpgrade(store, 'demo', true);
  assert.deepEqual([applied.applied], [true]);
  assert.match(applied.message, /^applied 1 repairable payload\(s\); 1 remain blocked: manual-action-required: /);
  assert.match(repairUpgrade(store, 'demo', false).message, /^manual-action-required: prompt payload missing required upsert fields/, 'sin reparables solo queda el bloqueo');
});

test('el hueco del diario se detecta y se rellena', (t) => {
  const { store } = seeded(t);
  const dry = repairUpgrade(store, 'demo', false);
  assert.deepEqual([dry.class, dry.reason_code, dry.planned_action, dry.applied], ['repairable', UPGRADE_REASON.repairBackfill, 'backfill_sync_journal', false]);
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM sync_mutations').n, 0);
  const applied = repairUpgrade(store, 'demo', true);
  assert.equal(applied.applied, true);
  assert.ok(store.db.get('SELECT COUNT(*) AS n FROM sync_mutations').n >= 2);
  assert.equal(readUpgradeState(store, 'demo').stage, UPGRADE_STAGE.repairApplied);
  assert.equal(repairUpgrade(store, 'demo', false).reason_code, UPGRADE_REASON.repairNoop);
});

test('remirror reencola el estado actual con una fuente nueva solo para proyectos inscritos', (t) => {
  const { store } = seeded(t);
  assert.throws(() => remirrorProject(store, ' '), /cloud remirror requires project/);
  assert.throws(() => remirrorProject(store, 'otro'), /cloud remirror requires enrolled project "otro"/);
  remirrorProject(store, 'demo');
  const sources = store.db.all('SELECT DISTINCT source FROM sync_mutations').map((r) => r.source);
  assert.equal(sources.length, 1);
  assert.match(sources[0], /^remirror:\d+$/);
  const count = store.db.get('SELECT COUNT(*) AS n FROM sync_mutations').n;
  assert.ok(count >= 2);
  remirrorProject(store, 'demo');
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM sync_mutations').n, count * 2, 'cada remirror usa una fuente propia');
});
