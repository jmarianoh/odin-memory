import { createHash } from 'node:crypto';
import { SYNC_ENTITY, SYNC_OP_DELETE, SYNC_OP_UPSERT } from '../store/journal.js';
import { decodeSyncPayload } from '../store/sync-apply.js';
import { newMutation } from '../store/sync-chunks.js';
import { goTrim } from '../store/text.js';
import { observationJson } from '../mcp/serialize.js';

/** Identificador de un chunk: los 8 primeros hexadecimales del SHA-256 de su JSON. */
export function chunkId(json) {
  return createHash('sha256').update(json).digest('hex').slice(0, 8);
}

/** Sesión tal como viaja en un chunk (los campos opcionales ausentes se omiten). */
export function sessionJson(s) {
  const out = { id: s.id, project: s.project ?? '' };
  if (s.ownership_mode) out.ownership_mode = s.ownership_mode;
  out.directory = s.directory ?? '';
  out.started_at = s.started_at;
  if (s.ended_at != null) out.ended_at = s.ended_at;
  if (s.summary != null) out.summary = s.summary;
  return out;
}

/** Prompt tal como viaja en un chunk. */
export function promptJson(p) {
  const out = {};
  if (p.source_inbox_id) out.source_inbox_id = p.source_inbox_id;
  out.id = p.id;
  out.sync_id = p.sync_id;
  out.session_id = p.session_id;
  out.content = p.content;
  if (p.project) out.project = p.project;
  out.created_at = p.created_at;
  return out;
}

/** Observación tal como viaja en un chunk, en el orden de campos del contrato. */
export function chunkObservationJson(o) {
  const j = observationJson(o);
  const out = { id: j.id, sync_id: j.sync_id, session_id: j.session_id, type: j.type, title: j.title, content: j.content };
  for (const key of ['tool_name', 'project']) if (j[key] !== undefined) out[key] = j[key];
  out.scope = j.scope;
  if (j.topic_key !== undefined) out.topic_key = j.topic_key;
  out.revision_count = j.revision_count;
  out.duplicate_count = j.duplicate_count;
  for (const key of ['last_seen_at', 'review_after', 'superseded_by_sync_id']) if (j[key] !== undefined) out[key] = j[key];
  out.created_at = j.created_at;
  out.updated_at = j.updated_at;
  if (j.deleted_at !== undefined) out.deleted_at = j.deleted_at;
  return out;
}

const orNull = (list) => (list.length > 0 ? list : null);

/**
 * Contenido de un chunk: `sessions`, `observations` y `prompts` (nulos si están
 * vacíos), `mutations` y `review_clears` solo si los hay.
 * @param {{ sessions: object[], observations: object[], prompts: object[], mutations?: object[], review_clears?: string[] }} chunk
 */
export function chunkToJson(chunk) {
  const observations = chunk.observations.map(chunkObservationJson);
  const out = {
    sessions: orNull(chunk.sessions.map(sessionJson)),
    // Una exportación incremental filtra la lista y deja `[]`; la primera la deja nula si no hay nada.
    observations: chunk.incremental ? observations : orNull(observations),
    prompts: orNull(chunk.prompts.map(promptJson)),
  };
  if (chunk.mutations?.length > 0) out.mutations = chunk.mutations;
  if (chunk.review_clears?.length > 0) out.review_clears = chunk.review_clears;
  return JSON.stringify(out);
}

/**
 * Interpreta el JSON de un chunk. Una sesión con propiedad de proyecto debe traer un
 * directorio que sea una cadena (no `null`).
 * @param {string} text
 * @returns {{ sessions: object[], observations: object[], prompts: object[], mutations: object[], review_clears: string[] }}
 */
export function parseChunk(text) {
  const raw = JSON.parse(text);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('chunk must be a JSON object');
  const list = (key) => {
    const value = raw[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error(`chunk ${key} must be an array`);
    return value;
  };
  const sessions = list('sessions');
  for (const [i, session] of sessions.entries()) {
    if (session?.ownership_mode === 'project_owned' && typeof session.directory !== 'string') {
      throw new Error(`sessions[${i}]: pulled session directory is invalid: directory must be non-blank`);
    }
  }
  return { sessions, observations: list('observations'), prompts: list('prompts'), mutations: list('mutations'), review_clears: list('review_clears') };
}

// ─── Mutaciones de un chunk ──────────────────────────────────────────────────

/** Mutaciones implícitas de las listas de sesiones, observaciones y prompts de un chunk. */
export function synthesizeMutations(chunk) {
  const mutations = [];
  for (const s of chunk.sessions) {
    const payload = { id: s.id, project: s.project, ownership_mode: s.ownership_mode ?? '', directory: s.directory, started_at: s.started_at, ended_at: s.ended_at ?? null, summary: s.summary ?? null };
    mutations.push(newMutation({ entity: SYNC_ENTITY.session, entity_key: s.id, op: SYNC_OP_UPSERT, payload: JSON.stringify(payload) }));
  }
  for (const o of chunk.observations) {
    const deleted = o.deleted_at !== undefined && o.deleted_at !== null;
    const fields = {
      sync_id: o.sync_id, session_id: o.session_id, type: o.type, title: o.title, content: o.content, tool_name: o.tool_name ?? null, project: o.project ?? null,
      scope: o.scope, topic_key: o.topic_key ?? null, revision_count: o.revision_count, duplicate_count: o.duplicate_count, last_seen_at: o.last_seen_at ?? null,
      created_at: o.created_at, updated_at: o.updated_at, deleted, deleted_at: o.deleted_at ?? null, hard_delete: false,
    };
    if (o.review_after !== undefined && o.review_after !== null) fields.review_after = o.review_after;
    if (o.superseded_by_sync_id !== undefined && o.superseded_by_sync_id !== null) fields.superseded_by_sync_id = o.superseded_by_sync_id;
    mutations.push(newMutation({ entity: SYNC_ENTITY.observation, entity_key: goTrim(o.sync_id), op: deleted ? SYNC_OP_DELETE : SYNC_OP_UPSERT, payload: JSON.stringify(fields) }));
  }
  for (const p of chunk.prompts) {
    const payload = { sync_id: p.sync_id, session_id: p.session_id, content: p.content, project: p.project ?? null, created_at: p.created_at };
    mutations.push(newMutation({ entity: SYNC_ENTITY.prompt, entity_key: goTrim(p.sync_id), op: SYNC_OP_UPSERT, payload: JSON.stringify(payload) }));
  }
  return mutations;
}

/** Identidad de una mutación: entidad y clave (la de una sesión se conserva tal cual). */
export function mutationIdentityKey(m) {
  const key = m.entity === SYNC_ENTITY.session ? m.entity_key : goTrim(m.entity_key ?? '');
  return `${m.entity}:${key}`;
}

function safeDecode(payload) {
  try {
    return decodeSyncPayload(payload);
  } catch {
    return null;
  }
}

function referencedSessionIds(mutations, { includeSessions }) {
  const ids = new Set();
  for (const m of mutations) {
    if (m.op !== SYNC_OP_UPSERT) continue;
    if (includeSessions && m.entity === SYNC_ENTITY.session) {
      if (goTrim(m.entity_key ?? '') !== '') ids.add(m.entity_key);
    } else if (m.entity === SYNC_ENTITY.observation || m.entity === SYNC_ENTITY.prompt) {
      const payload = safeDecode(m.payload);
      if (payload && goTrim(payload.session_id ?? '') !== '') ids.add(payload.session_id);
    }
  }
  return ids;
}

/**
 * Mutaciones que aplica la importación de un chunk: las explícitas más las implícitas
 * de las listas que no repiten una explícita (una sesión implícita solo si algo la necesita).
 */
export function buildImportMutations(chunk) {
  if (chunk.mutations.length === 0) return synthesizeMutations(chunk);
  const explicit = chunk.mutations;
  const required = referencedSessionIds(explicit, { includeSessions: true });
  const synthesized = synthesizeMutations(chunk);
  if (synthesized.length === 0) return explicit;
  const explicitKeys = new Set(explicit.map(mutationIdentityKey));
  const retained = synthesized.filter((m) => !explicitKeys.has(mutationIdentityKey(m)));
  for (const id of referencedSessionIds(retained, { includeSessions: false })) required.add(id);
  const merged = retained.filter((m) => !(m.entity === SYNC_ENTITY.session && m.op === SYNC_OP_UPSERT && !required.has(m.entity_key)));
  return [...merged, ...explicit];
}

/** Última mutación de cada identidad (lo que de verdad cuenta al importar). */
export function effectiveMutationsForImport(chunk) {
  const mutations = buildImportMutations(chunk);
  if (mutations.length <= 1) return mutations;
  const last = new Map();
  for (const [i, m] of mutations.entries()) last.set(mutationIdentityKey(m), i);
  return mutations.filter((m, i) => last.get(mutationIdentityKey(m)) === i);
}

/**
 * Orden de aplicación: altas de sesión, otras altas, relaciones, otros borrados y
 * borrados de sesión; un borrado de sesión que una alta posterior contradice se coloca
 * justo antes de esa alta, y un borrado reclama antes las altas anteriores de su misma
 * identidad.
 */
export function orderMutationsForApply(mutations) {
  if (mutations.length <= 1) return mutations;
  const indexed = mutations.map((mutation, index) => ({ mutation, index }));
  const sessionUpserts = indexed.filter((x) => x.mutation.entity === SYNC_ENTITY.session && x.mutation.op === SYNC_OP_UPSERT);
  const sessionDeletes = indexed.filter((x) => x.mutation.entity === SYNC_ENTITY.session && x.mutation.op === SYNC_OP_DELETE);
  const otherDeletes = indexed.filter((x) => x.mutation.entity !== SYNC_ENTITY.session && x.mutation.op === SYNC_OP_DELETE);
  const relationUpserts = indexed.filter((x) => x.mutation.entity === SYNC_ENTITY.relation && x.mutation.op !== SYNC_OP_DELETE);
  const otherUpserts = indexed.filter(
    (x) => x.mutation.op !== SYNC_OP_DELETE && x.mutation.entity !== SYNC_ENTITY.relation && !(x.mutation.entity === SYNC_ENTITY.session),
  );

  const relocateAt = sessionDeletes.map((deleted) => sessionUpserts.findIndex((u) => u.index > deleted.index && mutationIdentityKey(u.mutation) === mutationIdentityKey(deleted.mutation)));

  const ordered = [];
  let deleteCursor = 0;
  const otherEmitted = new Array(otherUpserts.length).fill(false);
  const relationEmitted = new Array(relationUpserts.length).fill(false);
  const drainPrecedingDeletes = (limit) => {
    while (deleteCursor < otherDeletes.length && otherDeletes[deleteCursor].index < limit) {
      const drained = otherDeletes[deleteCursor];
      for (const [slot, upsert] of otherUpserts.entries()) {
        if (!otherEmitted[slot] && upsert.index < drained.index && mutationIdentityKey(upsert.mutation) === mutationIdentityKey(drained.mutation)) {
          ordered.push(upsert.mutation);
          otherEmitted[slot] = true;
        }
      }
      for (const [slot, upsert] of relationUpserts.entries()) {
        if (!relationEmitted[slot] && upsert.index < drained.index && mutationIdentityKey(upsert.mutation) === mutationIdentityKey(drained.mutation)) {
          ordered.push(upsert.mutation);
          relationEmitted[slot] = true;
        }
      }
      ordered.push(drained.mutation);
      deleteCursor += 1;
    }
  };
  for (const [upsertPos, upsert] of sessionUpserts.entries()) {
    for (const [deletePos, deleted] of sessionDeletes.entries()) {
      if (relocateAt[deletePos] === upsertPos) {
        drainPrecedingDeletes(deleted.index);
        ordered.push(deleted.mutation);
      }
    }
    ordered.push(upsert.mutation);
  }
  for (const [slot, x] of otherUpserts.entries()) if (!otherEmitted[slot]) ordered.push(x.mutation);
  for (const [slot, x] of relationUpserts.entries()) if (!relationEmitted[slot]) ordered.push(x.mutation);
  for (; deleteCursor < otherDeletes.length; deleteCursor++) ordered.push(otherDeletes[deleteCursor].mutation);
  for (const [deletePos, deleted] of sessionDeletes.entries()) if (relocateAt[deletePos] === -1) ordered.push(deleted.mutation);
  return ordered;
}

/** Sesiones, observaciones y prompts que importaría el chunk (las altas efectivas). */
export function estimateImport(chunk) {
  const result = { sessions: 0, observations: 0, prompts: 0 };
  for (const m of effectiveMutationsForImport(chunk)) {
    if (m.op === SYNC_OP_DELETE) continue;
    if (m.entity === SYNC_ENTITY.session) result.sessions += 1;
    else if (m.entity === SYNC_ENTITY.observation) result.observations += 1;
    else if (m.entity === SYNC_ENTITY.prompt) result.prompts += 1;
  }
  return result;
}

/** Identificadores de sesión y proyecto de los registros que cuelgan de una sesión, para recuperar las que falten. */
export function referencedSessionProjects(mutations) {
  const projects = new Map();
  for (const m of mutations) {
    if (m.op !== SYNC_OP_UPSERT || (m.entity !== SYNC_ENTITY.observation && m.entity !== SYNC_ENTITY.prompt)) continue;
    const payload = safeDecode(m.payload);
    if (!payload) continue;
    const sessionId = payload.session_id;
    if (goTrim(sessionId ?? '') === '') continue;
    let project = goTrim(m.project ?? '');
    if (project === '' && typeof payload.project === 'string') project = goTrim(payload.project);
    const existing = goTrim(projects.get(sessionId) ?? '');
    if (!projects.has(sessionId) || existing === '' || (project !== '' && project < existing)) projects.set(sessionId, project);
  }
  return projects;
}
