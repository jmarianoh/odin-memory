import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { normalizeProject } from '../project/canonical.js';
import { canonicalizeForProject } from '../cloud/codec.js';
import {
  LOCAL_CHUNK_TARGET_KEY, ackSyncMutationSeqs, applyPulledChunk, countDeferredAndDead, exportData, exportLocalDeleteTombstones, exportProject, exportRelationMutations,
  ensureEnrolledProjectSyncMutations, exportReviewClearEvents, getSession, getSyncedChunksForTarget, hasProjectOwnedSessionsForProject, isProjectEnrolled, listPendingSyncMutationsAfterSeq,
  markSyncBlocked, recordSyncedChunkForTarget, replayDeferredForScope,
} from '../store/index.js';
import { SYNC_ENTITY, SYNC_OP_DELETE, SYNC_OP_UPSERT } from '../store/journal.js';
import { decodeSyncPayload } from '../store/sync-apply.js';
import { newMutation } from '../store/sync-chunks.js';
import { goTrim } from '../store/text.js';
import {
  buildImportMutations, chunkId, chunkToJson, effectiveMutationsForImport, estimateImport, mutationIdentityKey, orderMutationsForApply, parseChunk,
  referencedSessionProjects,
} from './chunks.js';
import { ChunkNotFoundError, FileTransport } from './transport.js';

/** Versión del manifiesto que reconoce el modo de propiedad de las sesiones. */
export const OWNERSHIP_MODE_MANIFEST_VERSION = 2;
const RECOVERED_SESSION_DIRECTORY = '(recovered-missing-session)';
const RECOVERED_SESSION_STARTED_AT = '1970-01-01 00:00:00';

/**
 * Fecha comparable: RFC 3339 → `YYYY-MM-DD HH:MM:SS.nnnnnnnnn` (UTC); otro texto, recortado.
 * @param {string} t
 */
export function normalizeTime(t) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(t ?? '');
  if (!m) return goTrim(t ?? '');
  const offset = m[8] === 'Z' ? 0 : (m[8][0] === '-' ? -1 : 1) * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(4, 6)));
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 60_000;
  const base = new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  return `${base}.${(m[7] ?? '').slice(1).padEnd(9, '0').slice(0, 9)}`;
}

/** Hora actual como `RFC3339Nano` (sin ceros finales en la fracción). */
function nowRfc3339() {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, (_, ms) => (ms === '000' ? 'Z' : `.${ms.replace(/0+$/, '')}Z`));
}

/** Nombre de quien exporta: `USER`, `USERNAME`, el nombre del equipo o `unknown`. */
export function getUsername(env = process.env) {
  if (env.USER) return env.USER;
  if (env.USERNAME) return env.USERNAME;
  let host = '';
  try {
    host = hostname();
  } catch {
    host = '';
  }
  return host || 'unknown';
}

/**
 * Resumen de un manifiesto: «N chunks, M memories, S sessions — contributors: a (n chunks)».
 * @param {{ chunks: object[] }} manifest
 */
export function manifestSummary(manifest) {
  if (manifest.chunks.length === 0) return 'No chunks synced yet.';
  let memories = 0;
  let sessions = 0;
  const authors = new Map();
  for (const c of manifest.chunks) {
    memories += c.memories;
    sessions += c.sessions;
    authors.set(c.created_by, (authors.get(c.created_by) ?? 0) + 1);
  }
  const list = [...authors.keys()].sort().map((a) => `${a} (${authors.get(a)} chunks)`);
  return `${manifest.chunks.length} chunks, ${memories} memories, ${sessions} sessions — contributors: ${list.join(', ')}`;
}

const stringKeys = (set) => new Set(set);

/** Tamaño máximo, serializado, de un chunk de la nube: cada tanda cabe en el límite de subida del servidor. */
export const CLOUD_EXPORT_MAX_CHUNK_BYTES = 4 << 20;
const PER_MUTATION_OVERHEAD = 128;
const canonicalProject = (project) => goTrim(normalizeProject(project ?? '').normalized);

/** La fila del diario tal como viaja en un chunk (`store.SyncMutation`). */
function journalMutationForChunk(row) {
  const out = {
    seq: Number(row.seq), target_key: row.target_key, entity: row.entity, entity_key: row.entity_key, op: row.op, payload: row.payload, source: row.source,
    project: row.project, occurred_at: row.occurred_at,
  };
  if (row.acked_at != null) out.acked_at = row.acked_at;
  out.disposition = row.disposition ?? 'pending';
  if (goTrim(row.disposition_reason ?? '') !== '') out.disposition_reason = row.disposition_reason;
  if (goTrim(row.disposition_evidence ?? '') !== '') out.disposition_evidence = row.disposition_evidence;
  if (row.disposition_at != null) out.disposition_at = row.disposition_at;
  return out;
}

/** Proyecto al que pertenece una mutación: el suyo, el de su carga o el de su sesión. */
function resolveMutationProject(mutation, sessionProjectById) {
  const own = canonicalProject(mutation.project);
  if (own !== '') return own;
  let payload;
  try {
    const first = JSON.parse(goTrim(mutation.payload ?? ''));
    payload = typeof first === 'string' ? JSON.parse(first) : first;
  } catch {
    return '';
  }
  if (payload === null || typeof payload !== 'object') return '';
  if (typeof payload.project === 'string') {
    const fromPayload = canonicalProject(goTrim(payload.project));
    if (fromPayload !== '') return fromPayload;
  }
  return canonicalProject(goTrim(sessionProjectById.get(typeof payload.session_id === 'string' ? payload.session_id : '') ?? ''));
}

/**
 * Sincronización por Git: exporta la memoria a chunks comprimidos e importa los de
 * otros. Cada exportación crea un chunk nuevo (nunca modifica uno anterior), de modo
 * que dos personas no provocan conflictos de fusión.
 */
export class Syncer {
  /**
   * @param {import('../store/store.js').Store} store
   * @param {object} options
   * @param {string} [options.syncDir] directorio de intercambio
   * @param {{ readManifest: Function, writeManifest: Function, writeChunk: Function, readChunk: Function }} [options.transport]
   * @param {string} [options.project] ámbito de la reaplicación de diferidos
   * @param {(message: string) => void} [options.log]
   * @param {string} [options.targetKey] destino con el que se anotan los chunks (por defecto `local`; la nube usa `cloud:<proyecto>`)
   * @param {boolean} [options.cloudMode] exporta lo pendiente del diario de mutaciones en lugar de los cambios desde el último chunk
   */
  constructor(store, { syncDir = '', transport, project = '', log, targetKey = LOCAL_CHUNK_TARGET_KEY, cloudMode = false } = {}) {
    this.store = store;
    this.cloudMode = cloudMode;
    this.targetKey = targetKey;
    this.syncDir = syncDir;
    this.transport = transport ?? new FileTransport(syncDir);
    this.project = goTrim(normalizeProject(project).normalized);
    this.log = log ?? store.config.log ?? (() => {});
  }

  /** Sincronizador sobre el sistema de archivos. */
  static local(store, syncDir, project = '', options = {}) {
    return new Syncer(store, { syncDir, project, ...options });
  }

  // ─── Exportar ──────────────────────────────────────────────────────────────

  /**
   * Crea un chunk con lo que aún no está en ningún chunk.
   * @param {string} createdBy
   * @param {string} [project] vacío = todos los proyectos
   * @param {{ includePrompts?: boolean }} [options] los prompts solo se comparten si se pide
   * @returns {{ chunk_id?: string, sessions_exported: number, observations_exported: number, prompts_exported: number, mutations_exported: number, is_empty: boolean }}
   */
  async export(createdBy, project = '', { includePrompts = false } = {}) {
    const name = goTrim(normalizeProject(project).normalized);
    this.#ensureCloudPreflight(name);
    if (this.syncDir !== '') {
      try {
        mkdirSync(join(this.syncDir, 'chunks'), { recursive: true, mode: 0o755 });
      } catch (err) {
        throw new Error(`create chunks dir: ${err.message}`, { cause: err });
      }
    }
    const manifest = await this.transport.readManifest();
    const locallySynced = getSyncedChunksForTarget(this.store, this.targetKey);
    const projectOwned = hasProjectOwnedSessionsForProject(this.store, name);
    const known = stringKeys(locallySynced);
    for (const c of manifest.chunks) known.add(c.id);

    let data;
    try {
      data = name !== '' ? exportProject(this.store, name) : exportData(this.store);
    } catch (err) {
      throw new Error(`export data: ${err.message}`, { cause: err });
    }
    if (name !== '' && !this.cloudMode) data = { ...data, observations: data.observations.filter((o) => o.scope === 'project') };
    if (projectOwned && manifest.version < OWNERSHIP_MODE_MANIFEST_VERSION) {
      manifest.version = OWNERSHIP_MODE_MANIFEST_VERSION;
      await this.transport.writeManifest(manifest);
    }

    if (this.cloudMode) {
      const { chunk, seqs } = this.#filterByPendingMutations(data, name);
      return this.#exportCloudMutationChunks(manifest, known, locallySynced, createdBy, name, chunk, seqs);
    }

    const relationMutations = exportRelationMutations(this.store, name);
    const lastChunkTime = this.#lastChunkTime(manifest);
    const historicalPrompts = new Set();
    const history = await this.#exportedChunkKeys(manifest, historicalPrompts);
    const localDeletes = exportLocalDeleteTombstones(this.store, name);
    const { reviewDates, exportedClears } = await this.#exportedReviewState(manifest);

    const chunk = this.#filterNewData(data, lastChunkTime);
    chunk.incremental = lastChunkTime !== '';
    // La historia de identidades de prompt (borrados incluidos) manda sobre la fecha.
    chunk.prompts = includePrompts ? data.prompts.filter((p) => !historicalPrompts.has(p.sync_id)) : [];
    chunk.observations = filterObservationsForExport(data.observations, history.historicalObservations, lastChunkTime);
    const selected = new Set(chunk.observations.map((o) => o.sync_id));
    for (const o of data.observations) {
      const prior = reviewDates.get(o.sync_id);
      if (o.review_after != null && prior && !prior.deleted && (prior.date === null || prior.date !== o.review_after) && !selected.has(o.sync_id)) {
        chunk.observations.push(o);
      }
    }
    includeObservationParentSessions(chunk, data.sessions);
    chunk.mutations = [
      ...filterRelationMutationsForExport(relationMutations, history.relations, lastChunkTime),
      ...localDeletes.filter((m) => !history.deletes.has(mutationIdentityKey(m))),
    ];
    chunk.review_clears = [];

    const observationsBySyncId = new Map(data.observations.map((o) => [o.sync_id, o]));
    for (const event of exportReviewClearEvents(this.store)) {
      const receipt = `${event.sync_id}:${event.id}:${event.key}`;
      const observation = observationsBySyncId.get(event.sync_id);
      if (!observation || exportedClears.has(receipt)) continue;
      chunk.review_clears.push(receipt);
      const [mutation] = synthesizeObservationMutation(observation);
      const fields = decodeSyncPayload(mutation.payload);
      fields.review_after = null;
      mutation.payload = JSON.stringify(fields);
      chunk.mutations.push(mutation);
    }
    this.#filterRelationMutationsForEndpointAvailability(chunk, data, history.observations, name !== '');

    if (chunk.sessions.length === 0 && chunk.observations.length === 0 && chunk.prompts.length === 0 && chunk.mutations.length === 0) {
      return { sessions_exported: 0, observations_exported: 0, prompts_exported: 0, mutations_exported: 0, is_empty: true };
    }

    const json = chunkToJson(chunk);
    const id = chunkId(json);
    // Que el chunk figure como conocido no prueba que su contenido exista: se restaura si falta.
    let payloadAvailable = false;
    if (known.has(id)) {
      try {
        await this.transport.readChunk(id);
        payloadAvailable = true;
      } catch (err) {
        if (!(err instanceof ChunkNotFoundError)) throw new Error(`read chunk ${id}: ${err.message}`, { cause: err });
      }
    }
    if (payloadAvailable) {
      if (!locallySynced.has(id)) recordSyncedChunkForTarget(this.store, this.targetKey, id);
      return { sessions_exported: 0, observations_exported: 0, prompts_exported: 0, mutations_exported: 0, is_empty: true };
    }

    let entry = {
      id, created_by: createdBy, created_at: nowRfc3339(), sessions: chunk.sessions.length, memories: chunk.observations.length, prompts: chunk.prompts.length,
    };
    const existing = manifest.chunks.find((c) => c.id === id);
    if (existing) entry = existing;
    try {
      await this.transport.writeChunk(id, json, entry);
    } catch (err) {
      throw new Error(`write chunk: ${err.message}`, { cause: err });
    }
    if (!existing) {
      manifest.chunks.push(entry);
      await this.transport.writeManifest(manifest);
    }
    recordSyncedChunkForTarget(this.store, this.targetKey, id);
    return {
      chunk_id: id, sessions_exported: chunk.sessions.length, observations_exported: chunk.observations.length, prompts_exported: chunk.prompts.length,
      mutations_exported: chunk.mutations.length, is_empty: false,
    };
  }

  /** En modo nube hace falta un proyecto explícito y que esté inscrito. */
  #ensureCloudPreflight(project) {
    if (!this.cloudMode) return;
    const name = project !== '' ? project : this.project;
    if (name === '') throw new Error('cloud sync requires an explicit --project scope; --all is not supported in cloud mode');
    if (isProjectEnrolled(this.store, name)) return;
    const message = `project ${JSON.stringify(name)} is not enrolled for cloud sync`;
    try {
      markSyncBlocked(this.store, this.targetKey, 'blocked_unenrolled', message);
    } catch {
      // El rechazo se informa aunque no se pueda anotar.
    }
    throw new Error(`cloud sync blocked_unenrolled: ${message}`);
  }

  /** Todas las mutaciones pendientes de salida, tras rellenar el diario de los proyectos inscritos. */
  #listPendingMutationsForExport() {
    try {
      ensureEnrolledProjectSyncMutations(this.store);
    } catch (err) {
      throw new Error(`repair enrolled sync journal: ${err.message}`, { cause: err });
    }
    const pageSize = 5000;
    const all = [];
    let after = 0;
    for (;;) {
      const batch = listPendingSyncMutationsAfterSeq(this.store, 'cloud', after, pageSize);
      if (batch.length === 0) break;
      all.push(...batch);
      const last = Number(batch.at(-1).seq);
      if (last <= after) throw new Error(`pending mutation pagination did not advance (after_seq=${after}, last_seq=${last})`);
      after = last;
      if (batch.length < pageSize) break;
    }
    return all;
  }

  /** El chunk de lo que el diario tiene pendiente para el proyecto, con las sesiones que sus filas necesitan. */
  #filterByPendingMutations(data, project) {
    if (project === '') return { chunk: emptyChunk(), seqs: [] };
    const mutations = this.#listPendingMutationsForExport();
    const sessionProjectById = new Map(data.sessions.map((session) => [session.id, canonicalProject(session.project)]));
    const availableSessions = new Set(data.sessions.map((s) => s.id));
    const availableObservations = new Set(data.observations.map((o) => o.sync_id));
    const availablePrompts = new Set(data.prompts.map((p) => p.sync_id));
    const sessionKeys = new Set();
    const observationIds = new Set();
    const promptIds = new Set();
    const seqs = [];
    const selected = [];
    for (const mutation of mutations) {
      if (mutation.project === '' && mutation.entity === SYNC_ENTITY.session && mutation.op === SYNC_OP_UPSERT && sessionProjectById.get(mutation.entity_key) === project) {
        throw new Error(`blank-project session mutation seq=${mutation.seq} entity_key=${JSON.stringify(mutation.entity_key)} requires cloud upgrade diagnosis and repair before export`);
      }
      const owner = resolveMutationProject(mutation, sessionProjectById);
      if (owner !== project) {
        if (owner !== '') continue;
        const available = { [SYNC_ENTITY.session]: availableSessions, [SYNC_ENTITY.observation]: availableObservations, [SYNC_ENTITY.prompt]: availablePrompts }[mutation.entity];
        if (!available || !available.has(mutation.entity_key)) continue;
      }
      if (mutation.project === '' && mutation.entity === SYNC_ENTITY.session && mutation.op === SYNC_OP_UPSERT) {
        throw new Error(`blank-project session mutation seq=${mutation.seq} entity_key=${JSON.stringify(mutation.entity_key)} has no authoritative local session in project ${JSON.stringify(project)}; run cloud upgrade doctor`);
      }
      seqs.push(Number(mutation.seq));
      selected.push(journalMutationForChunk(mutation));
      if (mutation.entity === SYNC_ENTITY.session) sessionKeys.add(mutation.entity_key);
      else if (mutation.entity === SYNC_ENTITY.observation) observationIds.add(mutation.entity_key);
      else if (mutation.entity === SYNC_ENTITY.prompt) promptIds.add(mutation.entity_key);
    }
    const chunk = emptyChunk();
    if (seqs.length === 0) return { chunk, seqs: [] };
    const referenced = new Set();
    for (const observation of data.observations) {
      if (!observationIds.has(observation.sync_id)) continue;
      chunk.observations.push(observation);
      referenced.add(observation.session_id);
    }
    for (const prompt of data.prompts) {
      if (!promptIds.has(prompt.sync_id)) continue;
      chunk.prompts.push(prompt);
      referenced.add(prompt.session_id);
    }
    for (const session of data.sessions) if (sessionKeys.has(session.id) || referenced.has(session.id)) chunk.sessions.push(session);
    chunk.mutations = selected;
    return { chunk, seqs };
  }

  /** Sube el chunk en tandas acotadas y acusa las mutaciones de cada tanda solo cuando ya está escrita. */
  async #exportCloudMutationChunks(manifest, known, locallySynced, createdBy, project, chunk, seqs) {
    const empty = { sessions_exported: 0, observations_exported: 0, prompts_exported: 0, mutations_exported: 0, chunks_exported: 0, is_empty: true };
    if (chunk.sessions.length === 0 && chunk.observations.length === 0 && chunk.prompts.length === 0 && chunk.mutations.length === 0) {
      if (seqs.length > 0) ackSyncMutationSeqs(this.store, 'cloud', seqs);
      return empty;
    }
    const projectName = project !== '' ? project : this.project;
    const result = { sessions_exported: 0, observations_exported: 0, prompts_exported: 0, mutations_exported: 0, chunks_exported: 0, is_empty: false };
    const sessionsExported = new Set();
    for (const part of splitCloudExportChunk(chunk, seqs, CLOUD_EXPORT_MAX_CHUNK_BYTES)) {
      let json;
      try {
        json = canonicalizeForProject(chunkToJson(part.chunk), projectName);
      } catch (err) {
        throw new Error(`canonicalize cloud chunk: ${err.message}`, { cause: err });
      }
      const id = chunkId(json);
      if (known.has(id)) {
        if (!locallySynced.has(id)) recordSyncedChunkForTarget(this.store, this.targetKey, id);
        if (part.seqs.length > 0) ackSyncMutationSeqs(this.store, 'cloud', part.seqs);
        continue;
      }
      const entry = {
        id, created_by: createdBy, created_at: nowRfc3339(), sessions: part.chunk.sessions.length, memories: part.chunk.observations.length, prompts: part.chunk.prompts.length,
      };
      try {
        await this.transport.writeChunk(id, json, entry);
      } catch (err) {
        throw new Error(`write chunk: ${err.message}`, { cause: err });
      }
      manifest.chunks.push(entry);
      await this.transport.writeManifest(manifest);
      recordSyncedChunkForTarget(this.store, this.targetKey, id);
      if (part.seqs.length > 0) ackSyncMutationSeqs(this.store, 'cloud', part.seqs);
      known.add(id);
      result.chunk_id = id;
      result.chunks_exported++;
      for (const session of part.chunk.sessions) sessionsExported.add(session.id);
      result.observations_exported += part.chunk.observations.length;
      result.prompts_exported += part.chunk.prompts.length;
      result.mutations_exported += part.chunk.mutations.length;
    }
    result.sessions_exported = sessionsExported.size;
    return result.chunks_exported === 0 ? empty : result;
  }

  #lastChunkTime(manifest) {
    if (manifest.chunks.length === 0) return '';
    let latest = manifest.chunks[0].created_at;
    for (const c of manifest.chunks.slice(1)) if (normalizeTime(c.created_at) > normalizeTime(latest)) latest = c.created_at;
    return latest;
  }

  #filterNewData(data, lastChunkTime) {
    if (lastChunkTime === '') return { sessions: data.sessions, observations: data.observations, prompts: data.prompts, mutations: [], review_clears: [] };
    const cutoff = normalizeTime(lastChunkTime);
    return {
      sessions: data.sessions.filter((s) => normalizeTime(s.started_at) > cutoff),
      observations: data.observations.filter((o) => normalizeTime(o.created_at) > cutoff || normalizeTime(o.updated_at) > cutoff),
      prompts: data.prompts.filter((p) => normalizeTime(p.created_at) > cutoff),
      mutations: [],
      review_clears: [],
    };
  }

  /** Lee cada chunk del manifiesto; uno ausente se omite. */
  async #chunks(manifest) {
    const out = [];
    for (const entry of manifest.chunks) {
      let text;
      try {
        text = await this.transport.readChunk(entry.id);
      } catch (err) {
        if (err instanceof ChunkNotFoundError) continue;
        throw new Error(`read chunk ${entry.id}: ${err.message}`, { cause: err });
      }
      let chunk;
      try {
        chunk = parseChunk(text);
      } catch (err) {
        throw new Error(`unmarshal chunk ${entry.id}: ${err.message}`, { cause: err });
      }
      out.push(chunk);
    }
    return out;
  }

  async #exportedReviewState(manifest) {
    const reviewDates = new Map();
    const exportedClears = new Set();
    for (const chunk of await this.#chunks(manifest)) {
      for (const receipt of chunk.review_clears) exportedClears.add(receipt);
      for (const mutation of buildImportMutations(chunk)) {
        if (mutation.entity !== SYNC_ENTITY.observation) continue;
        if (mutation.op === SYNC_OP_DELETE) {
          reviewDates.set(mutation.entity_key, { date: null, deleted: true });
          continue;
        }
        const fields = decodeSyncPayload(mutation.payload);
        if (Object.hasOwn(fields, 'review_after')) reviewDates.set(fields.sync_id, { date: fields.review_after, deleted: false });
        else if (reviewDates.get(fields.sync_id)?.deleted) reviewDates.delete(fields.sync_id);
      }
    }
    return { reviewDates, exportedClears };
  }

  async #exportedChunkKeys(manifest, promptHistory) {
    const relations = new Set();
    const observations = new Set();
    const historicalObservations = new Set();
    const deletes = new Set();
    for (const chunk of await this.#chunks(manifest)) {
      for (const o of chunk.observations) {
        observations.add(o.sync_id);
        historicalObservations.add(o.sync_id);
      }
      for (const p of chunk.prompts) promptHistory.add(p.sync_id);
      for (const mutation of effectiveMutationsForImport(chunk)) {
        if (mutation.entity === SYNC_ENTITY.prompt) promptHistory.add(mutation.entity_key);
        const key = mutationIdentityKey(mutation);
        if (mutation.op === SYNC_OP_DELETE) deletes.add(key);
        else deletes.delete(key);
      }
      for (const mutation of chunk.mutations) {
        if (mutation.entity === SYNC_ENTITY.relation) relations.add(mutation.entity_key);
        if (mutation.entity !== SYNC_ENTITY.observation) continue;
        if (mutation.op === SYNC_OP_DELETE) {
          if (goTrim(mutation.entity_key ?? '') !== '') historicalObservations.add(mutation.entity_key);
        } else if (mutation.op === SYNC_OP_UPSERT) {
          const syncId = observationUpsertIdentity(mutation);
          if (syncId !== null) {
            historicalObservations.add(syncId);
            observations.add(syncId);
          }
        }
      }
    }
    return { relations, observations, historicalObservations, deletes };
  }

  #filterRelationMutationsForEndpointAvailability(chunk, data, exportedObservations, requireProjectScope) {
    const bySyncId = new Map(data.observations.map((o) => [o.sync_id, o]));
    const included = new Set(exportedObservations);
    for (const o of chunk.observations) included.add(o.sync_id);
    const retained = [];
    for (const mutation of chunk.mutations) {
      if (mutation.entity !== SYNC_ENTITY.relation || mutation.op !== SYNC_OP_UPSERT) {
        retained.push(mutation);
        continue;
      }
      let payload;
      try {
        payload = decodeSyncPayload(mutation.payload);
      } catch (err) {
        throw new Error(`decode relation ${mutation.entity_key}: ${err.message}`, { cause: err });
      }
      let skip = false;
      for (const endpoint of [goTrim(payload.source_id ?? ''), goTrim(payload.target_id ?? '')]) {
        if (endpoint === '') throw new Error(`relation ${mutation.entity_key} has an empty endpoint`);
        const observation = bySyncId.get(endpoint);
        if (!observation) {
          this.log(`[sync] warning: skipping relation ${mutation.entity_key} because endpoint ${endpoint} is outside the project export`);
          skip = true;
        } else if (requireProjectScope && observation.scope !== 'project') {
          this.log(`[sync] warning: skipping relation ${mutation.entity_key} because endpoint ${endpoint} has ${JSON.stringify(observation.scope)} scope`);
          skip = true;
        } else if (!included.has(endpoint)) {
          this.log(`[sync] warning: skipping relation ${mutation.entity_key} because endpoint ${endpoint} was excluded by incremental export`);
          skip = true;
        }
        if (skip) break;
      }
      if (!skip) retained.push(mutation);
    }
    chunk.mutations = retained;
  }

  // ─── Importar ──────────────────────────────────────────────────────────────

  /**
   * Importa los chunks del manifiesto que aún no se conocen, respetando las
   * dependencias: un chunk que no puede aplicarse todavía se reintenta tras los demás.
   * @param {(progress: { local_chunks: number, remote_chunks: number, pending_chunks: number, percentage: number }) => void} [report]
   * @returns {{ chunks_imported: number, chunks_skipped: number, sessions_imported: number, observations_imported: number, prompts_imported: number, relations_replayed: number, relations_deferred: number, relations_dead: number }}
   */
  async import(report) {
    const manifest = await this.transport.readManifest();
    const entries = manifest.chunks;
    const known = getSyncedChunksForTarget(this.store, this.targetKey);
    let result;
    if (entries.length === 0) {
      result = this.#emptyImportResult();
    } else {
      let remaining = entries.filter((e) => !known.has(e.id)).length;
      const initial = remaining;
      const snapshot = () => ({
        local_chunks: known.size, remote_chunks: entries.length, pending_chunks: remaining, percentage: initial > 0 ? Math.floor(((initial - remaining) * 100) / initial) : 100,
      });
      report?.(snapshot());
      result = await this.#importEntries(entries, known, manifest.version, () => {
        remaining -= 1;
        if (remaining > 0) report?.(snapshot());
      });
      result = this.#finalize(result);
      report?.(snapshot());
      return result;
    }
    result = this.#finalize(result);
    if (report) {
      const snapshot = { local_chunks: known.size, remote_chunks: 0, pending_chunks: 0, percentage: 100 };
      report(snapshot);
    }
    return result;
  }

  #emptyImportResult() {
    return {
      chunks_imported: 0, chunks_skipped: 0, sessions_imported: 0, observations_imported: 0, prompts_imported: 0, relations_replayed: 0, relations_deferred: 0, relations_dead: 0,
    };
  }

  #finalize(result) {
    const replay = replayDeferredForScope(this.store, this.targetKey, this.project);
    result.relations_replayed = replay.succeeded;
    const counts = countDeferredAndDead(this.store, this.targetKey, this.project);
    result.relations_deferred = counts.deferred;
    result.relations_dead = counts.dead;
    return result;
  }

  async #readDecoded(entry) {
    const text = await this.transport.readChunk(entry.id);
    try {
      return parseChunk(text);
    } catch (err) {
      throw new Error(`parse chunk ${entry.id}: ${err.message}`, { cause: err });
    }
  }

  async #importEntries(entries, known, manifestVersion, afterCommit) {
    const result = this.#emptyImportResult();
    let pending = [];
    for (const entry of entries) {
      if (known.has(entry.id)) result.chunks_skipped += 1;
      else pending.push(entry);
    }
    if (pending.length === 0) return result;

    const decoded = new Map();
    if (manifestVersion < OWNERSHIP_MODE_MANIFEST_VERSION) {
      for (const entry of pending) {
        let chunk;
        try {
          chunk = await this.#readDecoded(entry);
        } catch (err) {
          if (err instanceof ChunkNotFoundError) continue;
          throw err instanceof Error && err.message.startsWith('parse chunk') ? err : new Error(`read chunk ${entry.id}: ${err.message}`, { cause: err });
        }
        this.#ensureOwnershipCompatibility(manifestVersion, chunk);
        decoded.set(entry.id, chunk);
      }
    }
    const availableSessionIds = await this.#sessionIdsAvailableInChunks(entries, known, decoded);

    const lastErrors = new Map();
    for (let pass = 1; pending.length > 0; pass++) {
      let progress = false;
      const next = [];
      for (const entry of pending) {
        let chunk = decoded.get(entry.id);
        if (!chunk) {
          try {
            chunk = await this.#readDecoded(entry);
          } catch (err) {
            if (err instanceof ChunkNotFoundError) {
              result.chunks_skipped += 1;
              continue;
            }
            throw err.message.startsWith('parse chunk') ? err : new Error(`read chunk ${entry.id}: ${err.message}`, { cause: err });
          }
          this.#ensureOwnershipCompatibility(manifestVersion, chunk);
        }
        const recovered = this.#recoverMissingSessionDependencies(chunk, availableSessionIds);
        if (recovered) chunk = recovered;
        try {
          this.#importChunk(entry.id, chunk);
        } catch (err) {
          lastErrors.set(entry.id, importDependencyError(chunk, err));
          next.push(entry);
          continue;
        }
        const imported = estimateImport(chunk);
        known.add(entry.id);
        lastErrors.delete(entry.id);
        decoded.delete(entry.id);
        result.chunks_imported += 1;
        result.sessions_imported += imported.sessions;
        result.observations_imported += imported.observations;
        result.prompts_imported += imported.prompts;
        afterCommit?.();
        progress = true;
      }
      if (!progress) {
        if (next.length === 0) return result;
        const stalled = next[0];
        throw new Error(`dependency-safe local import stalled after ${pass} pass(es); chunk ${stalled.id}: ${lastErrors.get(stalled.id).message}`, { cause: lastErrors.get(stalled.id) });
      }
      pending = next;
    }
    return result;
  }

  #importChunk(id, chunk) {
    applyPulledChunk(this.store, this.targetKey, id, orderMutationsForApply(buildImportMutations(chunk)));
  }

  async #sessionIdsAvailableInChunks(entries, known, decoded) {
    const available = new Set();
    for (const entry of entries) {
      let chunk = decoded.get(entry.id);
      if (!chunk) {
        let text;
        try {
          text = await this.transport.readChunk(entry.id);
        } catch (err) {
          if (err instanceof ChunkNotFoundError || known.has(entry.id)) continue;
          throw new Error(`read chunk ${entry.id}: ${err.message}`, { cause: err });
        }
        try {
          chunk = parseChunk(text);
        } catch (err) {
          if (known.has(entry.id)) continue;
          throw new Error(`parse chunk ${entry.id}: ${err.message}`, { cause: err });
        }
        if (!known.has(entry.id)) decoded.set(entry.id, chunk);
      }
      for (const m of buildImportMutations(chunk)) {
        if (m.entity === SYNC_ENTITY.session && m.op === SYNC_OP_UPSERT && goTrim(m.entity_key ?? '') !== '') available.add(m.entity_key);
      }
    }
    return available;
  }

  /** Si un chunk cuelga de una sesión que no existe en ningún sitio, la repone como una sesión vacía marcada. */
  #recoverMissingSessionDependencies(chunk, available) {
    const projects = referencedSessionProjects(buildImportMutations(chunk));
    if (projects.size === 0) return null;
    const missing = [];
    for (const sessionId of projects.keys()) {
      if (available.has(sessionId) || getSession(this.store, sessionId)) continue;
      missing.push(sessionId);
    }
    if (missing.length === 0) return null;
    missing.sort();
    const stubs = missing.map((id) => ({ id, project: projects.get(id), directory: RECOVERED_SESSION_DIRECTORY, started_at: RECOVERED_SESSION_STARTED_AT }));
    return { ...chunk, sessions: [...stubs, ...chunk.sessions] };
  }

  /** Un manifiesto sin modo de propiedad no puede traer sesiones con propiedad de proyecto ni tocar proyectos que ya las tienen. */
  #ensureOwnershipCompatibility(manifestVersion, chunk) {
    if (manifestVersion >= OWNERSHIP_MODE_MANIFEST_VERSION) return;
    const projects = new Set();
    const addProject = (project) => {
      const name = goTrim(normalizeProject(goTrim(project ?? '')).normalized);
      if (name !== '') projects.add(name);
    };
    for (const mutation of effectiveMutationsForImport(chunk)) {
      if (mutation.entity === SYNC_ENTITY.session) {
        let payload = {};
        const isDelete = mutation.op === SYNC_OP_DELETE;
        if (!isDelete || goTrim(mutation.payload ?? '') !== '') {
          try {
            payload = decodeSyncPayload(mutation.payload);
          } catch (err) {
            throw new Error(`decode session ownership payload: ${err.message}`, { cause: err });
          }
        }
        if (isDelete || payload.deleted || payload.hard_delete) {
          const id = goTrim(payload.id ?? '') === '' ? mutation.entity_key : payload.id;
          const session = getSession(this.store, id);
          if (session && session.ownership_mode === 'project_owned') {
            throw new Error(`sync downgrade is unsupported when a legacy delete targets project-owned session ${JSON.stringify(id)}`);
          }
          continue;
        }
        if (payload.ownership_mode === 'project_owned') {
          throw new Error(`sync downgrade is unsupported when incoming project-owned sessions exist; peer manifest version ${manifestVersion} does not support ownership modes`);
        }
        addProject(payload.project);
      } else if (mutation.entity === SYNC_ENTITY.observation || mutation.entity === SYNC_ENTITY.prompt) {
        let payload = {};
        if (mutation.op === SYNC_OP_UPSERT || goTrim(mutation.payload ?? '') !== '') {
          try {
            payload = decodeSyncPayload(mutation.payload);
          } catch (err) {
            throw new Error(`decode ${mutation.entity} ownership payload: ${err.message}`, { cause: err });
          }
        }
        addProject(goTrim(mutation.project ?? '') === '' && typeof payload.project === 'string' ? payload.project : mutation.project);
      }
    }
    for (const project of projects) {
      if (hasProjectOwnedSessionsForProject(this.store, project)) {
        throw new Error(`sync downgrade is unsupported after project-owned sessions exist for project ${JSON.stringify(project)}; peer manifest version ${manifestVersion} does not support ownership modes`);
      }
    }
  }

  // ─── Estado ────────────────────────────────────────────────────────────────

  /**
   * Chunks locales, chunks en el manifiesto y los que faltan por importar.
   * @returns {{ local: number, remote: number, pending: number }}
   */
  async status() {
    const manifest = await this.transport.readManifest();
    const known = getSyncedChunksForTarget(this.store, this.targetKey);
    return { local: known.size, remote: manifest.chunks.length, pending: manifest.chunks.filter((e) => !known.has(e.id)).length };
  }
}

// ─── Funciones puras de la exportación ───────────────────────────────────────

/** Observaciones nuevas: las que ningún chunk conocía, o creadas o modificadas desde el último chunk. */
export function filterObservationsForExport(observations, historical, lastChunkTime) {
  if (lastChunkTime === '') return observations;
  const cutoff = normalizeTime(lastChunkTime);
  return observations.filter((o) => !historical.has(o.sync_id) || normalizeTime(o.created_at) > cutoff || normalizeTime(o.updated_at) > cutoff);
}

/** Añade al chunk las sesiones de las que cuelgan sus observaciones y prompts. */
export function includeObservationParentSessions(chunk, sessions) {
  if (chunk.observations.length === 0 && chunk.prompts.length === 0) return;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const included = new Set(chunk.sessions.map((s) => s.id));
  chunk.sessions = [...chunk.sessions];
  for (const parent of [...chunk.observations.map((o) => o.session_id), ...chunk.prompts.map((p) => p.session_id)]) {
    if (included.has(parent)) continue;
    const session = byId.get(parent);
    if (session) {
      chunk.sessions.push(session);
      included.add(session.id);
    }
  }
}

/** Relaciones que aún no estaban en un chunk o que cambiaron desde el último. */
export function filterRelationMutationsForExport(mutations, exported, lastChunkTime) {
  if (mutations.length === 0) return [];
  if (lastChunkTime === '') return mutations;
  const cutoff = normalizeTime(lastChunkTime);
  return mutations.filter((m) => !exported.has(m.entity_key) || normalizeTime(m.occurred_at) > cutoff);
}

/** Identidad de una observación en una mutación `upsert`, o `null` si la carga no la tiene o no coincide con la clave. */
export function observationUpsertIdentity(mutation) {
  let body;
  try {
    body = decodeSyncPayload(mutation.payload);
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object' || typeof body.sync_id !== 'string' || goTrim(body.sync_id) === '' || body.sync_id !== mutation.entity_key) return null;
  return body.sync_id;
}

/** Mutación `upsert` de una observación (para reescribirla con la fecha de revisión vacía). */
function synthesizeObservationMutation(o) {
  const fields = {
    sync_id: o.sync_id, session_id: o.session_id, type: o.type, title: o.title, content: o.content, tool_name: o.tool_name ?? null, project: o.project ?? null,
    scope: o.scope, topic_key: o.topic_key ?? null, revision_count: o.revision_count, duplicate_count: o.duplicate_count, last_seen_at: o.last_seen_at ?? null,
    created_at: o.created_at, updated_at: o.updated_at, deleted: o.deleted_at != null, deleted_at: o.deleted_at ?? null, hard_delete: false,
  };
  if (o.review_after != null) fields.review_after = o.review_after;
  if (o.superseded_by_sync_id != null) fields.superseded_by_sync_id = o.superseded_by_sync_id;
  return [newMutation({ entity: SYNC_ENTITY.observation, entity_key: goTrim(o.sync_id), op: o.deleted_at != null ? SYNC_OP_DELETE : SYNC_OP_UPSERT, payload: JSON.stringify(fields) })];
}

/** Añade al error de una importación bloqueada las sesiones de las que el chunk aún depende. */
function importDependencyError(chunk, err) {
  const sessions = [...new Set([...referencedSessionProjects(buildImportMutations(chunk)).keys()])].sort();
  if (sessions.length === 0) return err;
  return new Error(`${err.message}; pending session dependencies: ${sessions.join(', ')}`, { cause: err });
}

const emptyChunk = () => ({ sessions: [], observations: [], prompts: [], mutations: [], review_clears: [], incremental: false });

/** Tamaño, en bytes, de una entidad ya serializada. */
const jsonSize = (value) => Buffer.byteLength(JSON.stringify(value));

/**
 * Parte un chunk respaldado por el diario en tandas acotadas y completas: las mutaciones conservan su orden y su
 * alineación con `seqs`, y cada tanda lleva las sesiones que sus observaciones y prompts referencian.
 * @returns {{ chunk: object, seqs: number[] }[]}
 */
export function splitCloudExportChunk(chunk, seqs, maxBytes) {
  if (!chunk || chunk.mutations.length === 0) return [];
  if (maxBytes <= 0 || seqs.length !== chunk.mutations.length) return [{ chunk, seqs }];
  const sessionById = new Map(chunk.sessions.map((s) => [s.id, s]));
  const sessionSize = new Map(chunk.sessions.map((s) => [s.id, jsonSize(s)]));
  const observationById = new Map(chunk.observations.map((o) => [o.sync_id, o]));
  const observationSize = new Map(chunk.observations.map((o) => [o.sync_id, jsonSize(o)]));
  const promptById = new Map(chunk.prompts.map((p) => [p.sync_id, p]));
  const promptSize = new Map(chunk.prompts.map((p) => [p.sync_id, jsonSize(p)]));

  const parts = [];
  let current = null;
  let bytes = 0;
  let sessions = new Set();
  let observations = new Set();
  let prompts = new Set();
  const reset = () => {
    current = { chunk: { ...emptyChunk() }, seqs: [] };
    bytes = 0;
    sessions = new Set();
    observations = new Set();
    prompts = new Set();
  };
  const plan = (mutation) => {
    const add = { cost: Buffer.byteLength(mutation.payload) + PER_MUTATION_OVERHEAD, sessions: [], obsId: '', promptId: '' };
    const needSession = (id) => {
      if (id === '' || id == null || sessions.has(id) || add.sessions.includes(id)) return;
      if (sessionSize.has(id)) {
        add.cost += sessionSize.get(id);
        add.sessions.push(id);
      }
    };
    if (mutation.entity === SYNC_ENTITY.session) {
      needSession(mutation.entity_key);
    } else if (mutation.entity === SYNC_ENTITY.observation && observationById.has(mutation.entity_key)) {
      if (!observations.has(mutation.entity_key)) {
        add.cost += observationSize.get(mutation.entity_key);
        add.obsId = mutation.entity_key;
      }
      needSession(observationById.get(mutation.entity_key).session_id);
    } else if (mutation.entity === SYNC_ENTITY.prompt && promptById.has(mutation.entity_key)) {
      if (!prompts.has(mutation.entity_key)) {
        add.cost += promptSize.get(mutation.entity_key);
        add.promptId = mutation.entity_key;
      }
      needSession(promptById.get(mutation.entity_key).session_id);
    }
    return add;
  };

  reset();
  for (const [i, mutation] of chunk.mutations.entries()) {
    let add = plan(mutation);
    if (current.chunk.mutations.length > 0 && bytes + add.cost > maxBytes) {
      parts.push(current);
      reset();
      add = plan(mutation);
    }
    current.chunk.mutations.push(mutation);
    current.seqs.push(seqs[i]);
    for (const id of add.sessions) {
      current.chunk.sessions.push(sessionById.get(id));
      sessions.add(id);
    }
    if (add.obsId !== '') {
      current.chunk.observations.push(observationById.get(add.obsId));
      observations.add(add.obsId);
    }
    if (add.promptId !== '') {
      current.chunk.prompts.push(promptById.get(add.promptId));
      prompts.add(add.promptId);
    }
    bytes += add.cost;
  }
  if (current.chunk.mutations.length > 0) parts.push(current);
  return parts;
}
