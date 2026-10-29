import { normalizeJson, summarizeChunk } from '../codec.js';
import {
  chunkMaterializedMutations, entrySignature, isChunkMaterializableEntity, materializeChunkMutation, mutationBatchChunks, mutationEntityKey, mutationSignature, parseTypedChunk, sessionFromMutation,
} from '../materialize.js';
import { goTrim } from '../../store/text.js';
import { isUniqueViolation } from './db.js';

/** Un chunk con ese identificador ya existe con otra carga. */
export class ChunkConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChunkConflictError';
  }
}

export class ChunkNotFoundInCloud extends Error {
  constructor(chunkId) {
    super(`cloudstore: chunk not found: ${JSON.stringify(chunkId)}`);
    this.name = 'ChunkNotFoundInCloud';
  }
}

export const AUDIT_ACTION_CHUNK_PUSH = 'chunk_push';
export const AUDIT_ACTION_MUTATION_PUSH = 'mutation_push';
export const AUDIT_OUTCOME_REJECTED_PROJECT_PAUSED = 'rejected_project_paused';

const DDL = [
  `CREATE TABLE IF NOT EXISTS cloud_chunks (
    project_name TEXT NOT NULL DEFAULT 'default',
    chunk_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    client_created_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload JSONB NOT NULL,
    sessions_count INTEGER NOT NULL DEFAULT 0,
    observations_count INTEGER NOT NULL DEFAULT 0,
    prompts_count INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS cloud_chunks_project_chunk_uidx ON cloud_chunks (project_name, chunk_id)',
  `CREATE TABLE IF NOT EXISTS cloud_project_sessions (
    project_name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_name, session_id)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_project_controls (
    project       TEXT PRIMARY KEY,
    sync_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
    paused_reason TEXT,
    updated_by    TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  'CREATE INDEX IF NOT EXISTS idx_cloud_project_controls_enabled ON cloud_project_controls(sync_enabled)',
  `CREATE TABLE IF NOT EXISTS cloud_mutations (
    seq        BIGSERIAL PRIMARY KEY,
    project    TEXT NOT NULL,
    entity     TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    op         TEXT NOT NULL,
    payload    JSONB NOT NULL DEFAULT '{}',
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  'CREATE INDEX IF NOT EXISTS idx_cloud_mutations_project ON cloud_mutations(project)',
  'CREATE INDEX IF NOT EXISTS idx_cloud_mutations_seq ON cloud_mutations(seq)',
  `CREATE TABLE IF NOT EXISTS cloud_sync_audit_log (
    id           SERIAL PRIMARY KEY,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    contributor  TEXT NOT NULL,
    project      TEXT NOT NULL,
    action       TEXT NOT NULL,
    outcome      TEXT NOT NULL,
    entry_count  INT NOT NULL DEFAULT 0,
    reason_code  TEXT,
    metadata     JSONB
  )`,
  'CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at ON cloud_sync_audit_log (occurred_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_audit_log_contributor_project ON cloud_sync_audit_log (contributor, project)',
  'CREATE INDEX IF NOT EXISTS idx_audit_log_outcome ON cloud_sync_audit_log (outcome)',
];

/**
 * Identificadores de las sesiones que declara un chunk ya decodificado: sus filas y las altas de sesión
 * de sus mutaciones (id de la carga o, si falta, la clave de entidad). Una mutación ilegible se ignora.
 */
export function collectSessionIds(chunk) {
  const ids = new Set();
  for (const s of chunk.sessions ?? []) if (goTrim(s?.id ?? '') !== '') ids.add(s.id);
  for (const m of chunk.mutations ?? []) {
    let entry;
    try {
      entry = materializeChunkMutation('', m);
      if (entry?.entity !== 'session' || entry.op !== 'upsert') continue;
      const id = sessionFromMutation(entry).id;
      if (typeof id === 'string' && goTrim(id) !== '') ids.add(id);
    } catch {
      continue;
    }
  }
  return ids;
}

/** Ids de sesión de una carga de chunk en texto; vacío si no se puede decodificar. */
function sessionIdsOfPayload(payload) {
  try {
    return collectSessionIds(parseTypedChunk(payload));
  } catch {
    return new Set();
  }
}

const rfc3339 = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Almacén de la nube sobre Postgres: chunks por proyecto, controles y auditoría. */
export class CloudStore {
  /** @param {import('./db.js').Database} db */
  constructor(db) {
    this.db = db;
  }

  async migrate() {
    for (const statement of DDL) await this.db.query(statement);
  }

  close() {
    return this.db.close();
  }

  /** Manifiesto v2 de los chunks del proyecto, por orden de llegada. */
  async readManifest(project) {
    const rows = await this.db.query(
      `SELECT chunk_id, created_by, COALESCE(client_created_at, created_at) AS manifest_created_at, sessions_count, observations_count, prompts_count
       FROM cloud_chunks WHERE project_name = $1 ORDER BY created_at ASC, chunk_id ASC`,
      [project],
    );
    return {
      version: 2,
      chunks: rows.map((r) => ({
        id: r.chunk_id,
        created_by: r.created_by,
        created_at: rfc3339(r.manifest_created_at),
        sessions: r.sessions_count,
        memories: r.observations_count,
        prompts: r.prompts_count,
      })),
    };
  }

  /** La carga del chunk tal como la devuelve Postgres (`jsonb::text`). */
  async readChunk(project, chunkId) {
    const rows = await this.db.query('SELECT payload::text AS payload FROM cloud_chunks WHERE project_name = $1 AND chunk_id = $2', [project, goTrim(chunkId)]);
    if (rows.length === 0) throw new ChunkNotFoundInCloud(chunkId);
    return rows[0].payload;
  }

  /** Sesiones que el servidor ya conoce del proyecto. */
  async knownSessionIds(project) {
    const rows = await this.db.query('SELECT session_id FROM cloud_project_sessions WHERE project_name = $1', [project]);
    return new Set(rows.map((r) => r.session_id).filter((id) => goTrim(id) !== ''));
  }

  /**
   * Guarda un chunk. Repetir el mismo chunk es inocuo; el mismo identificador con otra carga es un conflicto.
   * @param {string} payload JSON canónico
   * @param {string} clientCreatedAt RFC 3339 o vacío
   * @throws {ChunkConflictError}
   */
  async writeChunk(project, chunkId, createdBy, clientCreatedAt, payload) {
    const existing = await this.db.query('SELECT payload::text AS payload FROM cloud_chunks WHERE project_name = $1 AND chunk_id = $2', [project, chunkId]);
    if (existing.length > 0) {
      this.#assertSamePayload(chunkId, payload, existing[0].payload);
      await this.#indexSessions(this.db, project, sessionIdsOfPayload(payload));
      return;
    }
    let chunk;
    try {
      chunk = parseTypedChunk(payload);
    } catch (err) {
      throw new Error(`cloudstore: parse chunk for materialization: ${err.message}`);
    }
    const entries = chunkMaterializedMutations(project, chunk);
    const counts = summarizeChunk(payload);
    const originCreatedAt = goTrim(clientCreatedAt) === '' ? null : new Date(clientCreatedAt);
    try {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO cloud_chunks (project_name, chunk_id, created_by, client_created_at, payload, sessions_count, observations_count, prompts_count)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
          [project, goTrim(chunkId), goTrim(createdBy), originCreatedAt, payload, counts.sessions, counts.observations, counts.prompts],
        );
        await this.#indexSessions(tx, project, sessionIdsOfPayload(payload));
        await insertMaterialized(tx, entries);
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Otra petición lo insertó entre la lectura y la escritura.
      const again = await this.db.query('SELECT payload::text AS payload FROM cloud_chunks WHERE project_name = $1 AND chunk_id = $2', [project, chunkId]);
      if (again.length === 0) throw new ChunkConflictError(`existing chunk ${JSON.stringify(chunkId)} was concurrently inserted`);
      this.#assertSamePayload(chunkId, payload, again[0].payload);
    }
  }

  #assertSamePayload(chunkId, incoming, existing) {
    if (normalizeJson(incoming) !== normalizeJson(existing)) throw new ChunkConflictError(`existing chunk ${JSON.stringify(chunkId)} has different payload`);
  }

  async #indexSessions(runner, project, sessionIds) {
    for (const id of sessionIds) {
      await runner.query('INSERT INTO cloud_project_sessions (project_name, session_id) VALUES ($1, $2) ON CONFLICT (project_name, session_id) DO NOTHING', [project, id]);
    }
  }

  /** Sin fila de control, la sincronización está activa. */
  async isProjectSyncEnabled(project) {
    const rows = await this.db.query('SELECT sync_enabled FROM cloud_project_controls WHERE project = $1', [goTrim(project)]);
    return rows.length === 0 ? true : rows[0].sync_enabled;
  }

  async setProjectSyncEnabled(project, enabled, updatedBy = '', reason = '') {
    await this.db.query(
      `INSERT INTO cloud_project_controls (project, sync_enabled, paused_reason, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (project) DO UPDATE SET sync_enabled = EXCLUDED.sync_enabled, paused_reason = EXCLUDED.paused_reason, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [goTrim(project), enabled, enabled ? null : goTrim(reason) || null, goTrim(updatedBy) || null],
    );
  }

  async insertAuditEntry({ contributor, project, action, outcome, entryCount = 0, reasonCode = '', metadata = null }) {
    const reason = goTrim(reasonCode);
    const hasMetadata = metadata !== null && Object.keys(metadata).length > 0;
    await this.db.query(
      `INSERT INTO cloud_sync_audit_log (contributor, project, action, outcome, entry_count, reason_code, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [contributor, project, action, outcome, entryCount, reason === '' ? null : reason, hasMetadata ? JSON.stringify(metadata) : null],
    );
  }

  // ─── Diario de mutaciones ────────────────────────────────────────────────

  /**
   * Inserta un lote de mutaciones y, en la misma transacción, el chunk equivalente de cada proyecto.
   * @param {{ project: string, entity: string, entity_key: string, op: string, payload: string, created_by?: string }[]} batch
   * @returns {Promise<number[]>} los números de secuencia asignados, en orden
   */
  async insertMutationBatch(batch) {
    if (batch.length === 0) return [];
    const chunks = mutationBatchChunks(batch);
    return this.db.transaction(async (tx) => {
      const seqs = [];
      for (const [batchIndex, entry] of batch.entries()) {
        const entity = goTrim(entry.entity);
        const entityKey = mutationEntityKey(entry.entity, entry.entity_key);
        try {
          const rows = await tx.query(
            'INSERT INTO cloud_mutations (project, entity, entity_key, op, payload) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING seq',
            [goTrim(entry.project), entity, entityKey, goTrim(entry.op), goTrim(entry.payload ?? '') === '' ? '{}' : entry.payload],
          );
          seqs.push(Number(rows[0].seq));
        } catch (cause) {
          throw new MutationBatchEntryError(batchIndex, entity, entityKey, cause);
        }
      }
      for (const chunk of chunks) {
        await tx.query(
          `INSERT INTO cloud_chunks (project_name, chunk_id, created_by, payload, sessions_count, observations_count, prompts_count)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) ON CONFLICT (project_name, chunk_id) DO NOTHING`,
          [chunk.project, chunk.id, chunk.created_by === '' ? 'unknown' : chunk.created_by, chunk.payload, chunk.counts.sessions, chunk.counts.observations, chunk.counts.prompts],
        );
        await this.#indexSessions(tx, chunk.project, sessionIdsOfPayload(chunk.payload));
      }
      return seqs;
    });
  }

  /**
   * Mutaciones con `seq` mayor que `sinceSeq`, por orden. `allowedProjects` nulo = sin filtro; una lista
   * (aunque vacía) restringe a esos proyectos.
   * @returns {Promise<{ mutations: object[], has_more: boolean, latest_seq: number }>}
   */
  async listMutationsSince(sinceSeq, limit, allowedProjects) {
    const size = limit <= 0 || limit > 100 ? 100 : limit;
    if (allowedProjects !== null && allowedProjects.length === 0) return { mutations: [], has_more: false, latest_seq: 0 };
    const rows = allowedProjects === null
      ? await this.db.query(
        'SELECT seq, project, entity, entity_key, op, payload::text AS payload, occurred_at FROM cloud_mutations WHERE seq > $1 ORDER BY seq ASC LIMIT $2',
        [sinceSeq, size + 1],
      )
      : await this.db.query(
        'SELECT seq, project, entity, entity_key, op, payload::text AS payload, occurred_at FROM cloud_mutations WHERE seq > $1 AND project = ANY($2) ORDER BY seq ASC LIMIT $3',
        [sinceSeq, allowedProjects, size + 1],
      );
    const hasMore = rows.length > size;
    const page = hasMore ? rows.slice(0, size) : rows;
    const mutations = page.map((r) => ({
      seq: Number(r.seq), project: r.project, entity: r.entity, entity_key: r.entity_key, op: r.op, payload: JSON.parse(r.payload), occurred_at: rfc3339(r.occurred_at),
    }));
    return { mutations, has_more: hasMore, latest_seq: mutations.length > 0 ? mutations.at(-1).seq : 0 };
  }

  /**
   * Materializa en `cloud_chunks` las mutaciones del diario de un proyecto que ningún chunk contiene aún.
   * Sin `apply` solo informa.
   */
  async backfillMutationChunks(project, apply) {
    const name = goTrim(project);
    if (name === '') throw new Error('cloudstore: project is required');
    const report = { project: name, applied: apply, candidate_mutations: 0, already_materialized: 0, invalid_mutations: 0, chunks_planned: 0, chunks_inserted: 0 };
    const materialized = await this.#existingChunkSignatures(name);
    const rows = await this.db.query('SELECT project, entity, entity_key, op, payload::text AS payload FROM cloud_mutations WHERE project = $1 ORDER BY seq ASC', [name]);
    const missing = [];
    for (const row of rows) {
      if (!isChunkMaterializableEntity(row.entity)) continue;
      report.candidate_mutations++;
      let signature;
      try {
        signature = entrySignature(row);
      } catch {
        report.invalid_mutations++;
        continue;
      }
      if (materialized.has(signature)) {
        report.already_materialized++;
        continue;
      }
      missing.push(row);
    }
    const chunks = [];
    for (let start = 0; start < missing.length; start += BACKFILL_CHUNK_SIZE) chunks.push(...mutationBatchChunks(missing.slice(start, start + BACKFILL_CHUNK_SIZE)));
    report.chunks_planned = chunks.length;
    if (!apply || chunks.length === 0) return report;
    await this.db.transaction(async (tx) => {
      for (const chunk of chunks) {
        const inserted = await tx.query(
          `INSERT INTO cloud_chunks (project_name, chunk_id, created_by, payload, sessions_count, observations_count, prompts_count)
           VALUES ($1, $2, 'mutation-backfill', $3::jsonb, $4, $5, $6) ON CONFLICT (project_name, chunk_id) DO NOTHING RETURNING chunk_id`,
          [chunk.project, chunk.id, chunk.payload, chunk.counts.sessions, chunk.counts.observations, chunk.counts.prompts],
        );
        if (inserted.length > 0) report.chunks_inserted++;
        await this.#indexSessions(tx, chunk.project, sessionIdsOfPayload(chunk.payload));
      }
    });
    return report;
  }

  async #existingChunkSignatures(project) {
    const rows = await this.db.query('SELECT payload::text AS payload FROM cloud_chunks WHERE project_name = $1', [project]);
    const signatures = new Set();
    for (const row of rows) {
      let chunk;
      try {
        chunk = parseTypedChunk(row.payload);
      } catch (err) {
        throw new Error(`cloudstore: parse existing chunk mutations: ${err.message}`);
      }
      for (const mutation of chunk.mutations) {
        if (!isChunkMaterializableEntity(mutation.entity)) continue;
        try {
          signatures.add(mutationSignature(mutation));
        } catch (err) {
          throw new Error(`cloudstore: sign existing chunk mutation ${mutation.project}/${mutation.entity}/${mutation.entity_key}: ${err.message}`);
        }
      }
    }
    return signatures;
  }
}

const BACKFILL_CHUNK_SIZE = 100;

/** Una fila de un lote de mutaciones no se pudo insertar. */
export class MutationBatchEntryError extends Error {
  constructor(batchIndex, entity, entityKey, cause) {
    super(`cloudstore: mutation batch entry rejected: reason=mutation_insert_rejected batch_index=${batchIndex} entity=${JSON.stringify(entity.slice(0, 64))} entity_key=${JSON.stringify(entityKey.slice(0, 64))}`, { cause });
    this.name = 'MutationBatchEntryError';
    this.batchIndex = batchIndex;
    this.entity = entity;
    this.entityKey = entityKey;
  }
}

async function insertMaterialized(tx, entries) {
  for (const entry of entries) {
    try {
      await tx.query(
        'INSERT INTO cloud_mutations (project, entity, entity_key, op, payload) VALUES ($1, $2, $3, $4, $5::jsonb)',
        [goTrim(entry.project), goTrim(entry.entity), mutationEntityKey(entry.entity, entry.entity_key), goTrim(entry.op), entry.payload === '' ? '{}' : entry.payload],
      );
    } catch (err) {
      throw new Error(`cloudstore: insert materialized chunk mutation ${entry.project}/${entry.entity}/${entry.entity_key}: ${err.message}`, { cause: err });
    }
  }
}
