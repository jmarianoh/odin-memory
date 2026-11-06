import { createHash } from 'node:crypto';
import { normalizeProject } from '../project/canonical.js';
import { now } from '../timeutil/index.js';
import { storeError } from './errors.js';
import { SYNC_ENTITY, SYNC_OP_DELETE, journalMutation, sessionProject } from './journal.js';
import { getObservationRow, journalObservation, validateExpectedProject } from './observations.js';
import { hashNormalized, newSyncId, normalizeScope, normalizeTopicKey, nullableString } from './text.js';

export const CONSOLIDATED_FROM_MARKER = '## consolidated_from';
export const CONSOLIDATE_FINGERPRINT_VERSION = 'consolidate:v2';
const SYNC_ID_PATTERN = /obs-[0-9a-f]+/g;

const fail = (code, error) => Object.assign(storeError(code), error ?? {});

/** Sección de procedencia (lo que sigue al marcador) o cadena vacía. */
function provenanceSection(content) {
  const idx = content.indexOf(CONSOLIDATED_FROM_MARKER);
  return idx < 0 ? '' : content.slice(idx + CONSOLIDATED_FROM_MARKER.length);
}

function contentWithProvenance(base, sources) {
  return `${base.replace(/\n+$/, '')}\n\n${CONSOLIDATED_FROM_MARKER}\n${sources.map((s) => `- ${s.sync_id}\n`).join('')}`;
}

/** Huella determinista del plan: cambia si cambian las fuentes o el superviviente. */
function fingerprintOf(sources, survivor) {
  const ordered = [...sources].sort((a, b) => a.id - b.id);
  const payload = JSON.stringify({ version: CONSOLIDATE_FINGERPRINT_VERSION, sources: ordered, survivor });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function buildPlan(db, ids, overrides) {
  const sources = ids.map((id) => {
    const obs = getObservationRow(db, id);
    if (!obs) throw storeError('consolidate_missing_observation');
    return obs;
  });
  sources.sort((a, b) => (a.created_at !== b.created_at ? (a.created_at < b.created_at ? 1 : -1) : b.id - a.id));

  let canonical = '';
  const batch = new Set();
  sources.forEach((src, i) => {
    let project = src.project ?? '';
    if (project === '') project = sessionProject(db, src.session_id);
    project = normalizeProject(project).normalized;
    if (project === '') throw storeError('project_required');
    src.project = project;
    if (i === 0) canonical = project;
    else if (project !== canonical) throw storeError('consolidate_cross_project');
    batch.add(src.sync_id);
  });
  for (const src of sources) {
    for (const listed of provenanceSection(src.content).match(SYNC_ID_PATTERN) ?? []) {
      if (batch.has(listed)) throw storeError('consolidate_provenance_cycle');
    }
  }

  const newest = sources[0];
  const survivor = {
    session_id: newest.session_id,
    title: overrides.title || sources.map((s) => s.title).join(' · '),
    content: '',
    type: overrides.type || newest.type,
    scope: normalizeScope(newest.scope),
    project: canonical,
    topic_key: normalizeTopicKey(overrides.topic_key ?? ''),
  };
  survivor.content = contentWithProvenance(overrides.content || sources.map((s) => s.content).join('\n\n'), sources);
  return { ids, sources, survivor, project: canonical, fingerprint: fingerprintOf(sources, survivor) };
}

function execute(db, plan) {
  const syncId = newSyncId('obs');
  const s = plan.survivor;
  const res = db.run(
    `INSERT INTO observations (sync_id, session_id, type, title, content, tool_name, project, scope, topic_key, normalized_hash, revision_count, duplicate_count, last_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CAST(? AS TEXT), ?, ?, ?, 1, 1, datetime('now'), datetime('now'))`,
    syncId, s.session_id, s.type, s.title, s.content, 'mem_consolidate', s.project, s.scope, nullableString(s.topic_key), hashNormalized(s.content),
  );
  const survivorId = Number(res.lastInsertRowid);
  journalObservation(db, getObservationRow(db, survivorId));
  for (const src of [...plan.sources].sort((a, b) => a.id - b.id)) {
    const deletedAt = now();
    db.run(
      'UPDATE observations SET deleted_at = ?, superseded_by_sync_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      deletedAt, syncId, deletedAt, src.id,
    );
    journalMutation(db, {
      entity: SYNC_ENTITY.observation,
      entityKey: src.sync_id,
      op: SYNC_OP_DELETE,
      project: plan.project,
      sessionId: src.session_id,
      payload: () => ({ sync_id: src.sync_id, session_id: src.session_id, project: src.project, deleted: true, deleted_at: deletedAt, superseded_by_sync_id: syncId }),
    });
  }
  return getObservationRow(db, survivorId);
}

/**
 * Fusiona varias observaciones en una nueva que las sustituye. Funciona en dos
 * pasos: sin `confirm` devuelve el plan (con su huella) sin escribir; con
 * `confirm` y la huella del plan, lo ejecuta. Si las fuentes cambiaron entre
 * ambos pasos falla con `consolidate_fingerprint_mismatch` (el error lleva el
 * plan nuevo en `plan`).
 *
 * El superviviente toma sesión, ámbito y tipo de la fuente más reciente, un
 * título y contenido combinados (salvo `overrides`) y una sección
 * `## consolidated_from` con los `sync_id` de origen. Las fuentes quedan
 * borradas con `superseded_by_sync_id` apuntando al superviviente.
 *
 * @param {import('./store.js').Store} store
 * @param {object} p
 * @param {number[]} p.ids al menos dos, sin repetir
 * @param {{ title?: string, content?: string, type?: string, topic_key?: string }} [p.overrides]
 * @param {boolean} [p.confirm]
 * @param {string} [p.fingerprint] huella del plan que se confirma
 * @param {string} [p.expected_project] exige que sea el proyecto de las fuentes
 * @returns {{ plan: object, survivor?: object }}
 */
export function consolidateObservations(store, p) {
  const expected = p.expected_project === undefined ? null : validateExpectedProject(p.expected_project);
  const ids = p.ids ?? [];
  if (ids.length < 2) throw storeError('consolidate_need_two_sources');
  if (new Set(ids).size !== ids.length) throw storeError('consolidate_duplicate_id');
  const overrides = p.overrides ?? {};
  const checkProject = (plan) => {
    if (expected !== null && plan.project !== expected) throw storeError('observation_project_mismatch');
  };

  if (!p.confirm) {
    return store.db.transaction((db) => {
      const plan = buildPlan(db, ids, overrides);
      checkProject(plan);
      return { plan };
    });
  }
  return store.db.writeTransaction((db) => {
    const plan = buildPlan(db, ids, overrides);
    checkProject(plan);
    if (plan.fingerprint !== p.fingerprint) throw fail('consolidate_fingerprint_mismatch', { plan });
    return { plan, survivor: execute(db, plan) };
  });
}
